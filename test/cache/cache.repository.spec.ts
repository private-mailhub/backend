import { CacheRepository } from '../../src/cache/cache.repository';

describe('CacheRepository', () => {
  let repository: CacheRepository;
  let redisClient: { eval: jest.Mock };

  beforeEach(() => {
    redisClient = { eval: jest.fn().mockResolvedValue(1) };
    repository = new CacheRepository({
      stores: [{ store: { client: redisClient } }],
    } as never);
  });

  it('API 키 quota 저장은 남은 키 TTL에 맞춰 owner index TTL을 갱신하는 Lua를 실행한다', async () => {
    // Given
    const recordKey = 'api-key:record:public-id';
    const ownerIndexKey = 'api-key:owner:17';
    const ttlMs = 365 * 24 * 60 * 60 * 1000;
    const record = { publicId: 'public-id', userId: '17', id: 1 };

    // When
    const result = await repository.setApiKeyWithQuota(
      recordKey,
      record,
      ttlMs,
      ownerIndexKey,
      'public-id',
      '17',
      100,
    );

    // Then
    expect(result).toBe('created');
    const [script, options] = redisClient.eval.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] },
    ];
    expect(script).toContain('if existingTtl > maxTtl then maxTtl = existingTtl end');
    expect(script).toContain("redis.call('PEXPIRE', KEYS[2], maxTtl)");
    expect(options.keys).toEqual([recordKey, ownerIndexKey]);
    expect(options.arguments.slice(1)).toEqual([String(ttlMs), 'public-id', '17', '100']);
  });

  it('API 키 폐기는 제한 TTL을 전달하고 owner index의 남은 TTL을 다시 계산한다', async () => {
    // Given
    const recordKey = 'api-key:record:public-id';
    const ownerIndexKey = 'api-key:owner:17';
    const retentionTtlMs = 30 * 24 * 60 * 60 * 1000;
    const revokedAt = '2026-10-07T00:00:00.000Z';

    // When
    const result = await repository.revokeApiKey(
      recordKey,
      '17',
      revokedAt,
      retentionTtlMs,
      ownerIndexKey,
      'public-id',
    );

    // Then
    expect(result).toBe(true);
    const [script, options] = redisClient.eval.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] },
    ];
    expect(script).toContain('local nextTtl = tonumber(ARGV[3])');
    expect(script).toContain('if ttl > 0 and ttl < nextTtl then nextTtl = ttl end');
    expect(script).toContain('if wasAlreadyRevoked then return 2 end');
    expect(script).toContain("if maxTtl > 0 then redis.call('PEXPIRE', KEYS[2], maxTtl) end");
    expect(options).toEqual({
      keys: [recordKey, ownerIndexKey],
      arguments: ['17', revokedAt, String(retentionTtlMs), 'public-id'],
    });
  });

  it('이미 폐기된 키의 idempotent 상태 코드를 성공으로 처리한다', async () => {
    // Given
    redisClient.eval.mockResolvedValueOnce(2);

    // When
    const result = await repository.revokeApiKey(
      'api-key:record:public-id',
      '17',
      '2026-10-07T00:00:00.000Z',
      30 * 24 * 60 * 60 * 1000,
      'api-key:owner:17',
      'public-id',
    );

    // Then
    expect(result).toBe(true);
  });
});
