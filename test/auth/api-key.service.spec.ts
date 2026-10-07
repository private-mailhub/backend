import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { CacheRepository } from '../../src/cache/cache.repository';
import { ApiKeyService } from '../../src/auth/api-key.service';
import { ProtectionUtil } from '../../src/common/utils/protection.util';
import { CustomEnvService } from '../../src/config/custom-env.service';
import { UsersService } from '../../src/users/users.service';
import { UserStatus } from '../../src/users/user.enums';

const revokedApiKeyRetentionMs = 30 * 24 * 60 * 60 * 1000;

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let cacheRepository: CacheRepository & Record<string, jest.Mock>;
  let protectionUtil: jest.Mocked<ProtectionUtil>;
  let usersService: jest.Mocked<UsersService>;
  let values: Map<string, unknown>;
  let sets: Map<string, Set<string>>;
  let expiresAtByKey: Map<string, number>;
  let jwtSecret: string;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
    values = new Map();
    sets = new Map();
    expiresAtByKey = new Map();
    jwtSecret = 'stable-test-secret-for-api-key-idempotency';
    let sequence = 0;
    cacheRepository = {
      set: jest.fn((key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      }),
      get: jest.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
      del: jest.fn((key: string) => {
        values.delete(key);
        return Promise.resolve();
      }),
      getAndDelete: jest.fn((key: string) => {
        const value = values.get(key) ?? null;
        values.delete(key);
        return Promise.resolve(value);
      }),
      increment: jest.fn(() => Promise.resolve(++sequence)),
      incrementWithExpiry: jest.fn(() => Promise.resolve(1)),
      setApiKeyWithQuota: jest.fn(
        (
          key: string,
          value: unknown,
          _ttlMs: number,
          setKey: string,
          member: string,
          _ownerId: string,
          maxKeys: number,
        ) => {
          const candidateExpiry = expiresAtByKey.get(key);
          if (values.has(key) && (candidateExpiry === undefined || candidateExpiry > Date.now())) {
            return Promise.resolve('collision' as const);
          }
          values.delete(key);
          expiresAtByKey.delete(key);
          const members = sets.get(setKey) ?? new Set<string>();
          for (const existingMember of members) {
            const existingKey = `api-key:record:${existingMember}`;
            const expiry = expiresAtByKey.get(existingKey);
            if (!values.has(existingKey) || expiry === undefined || expiry <= Date.now()) {
              values.delete(existingKey);
              expiresAtByKey.delete(existingKey);
              members.delete(existingMember);
            }
          }
          if (members.size >= maxKeys) {
            return Promise.resolve('limit' as const);
          }
          values.set(key, value);
          expiresAtByKey.set(key, Date.now() + _ttlMs);
          members.add(member);
          sets.set(setKey, members);
          return Promise.resolve('created' as const);
        },
      ),
      setManyWithExpiry: jest.fn(
        (entries: Array<{ key: string; value: unknown; ttlMs: number }>) => {
          entries.forEach(({ key, value }) => values.set(key, value));
          return Promise.resolve();
        },
      ),
      setManyIfAbsentWithExpiry: jest.fn(
        (entries: Array<{ key: string; value: unknown; ttlMs: number }>) => {
          if (entries.some(({ key }) => values.has(key))) {
            return Promise.resolve(false);
          }
          entries.forEach(({ key, value }) => values.set(key, value));
          return Promise.resolve(true);
        },
      ),
      transitionJson: jest.fn((key: string, expectedStatus: string, nextValue: unknown) => {
        const value = values.get(key) as { status?: string } | undefined;
        if (!value || value.status !== expectedStatus) {
          return Promise.resolve(false);
        }
        values.set(key, nextValue);
        return Promise.resolve(true);
      }),
      updateApiKeyLastUsed: jest.fn(
        (key: string, expectedSecretHash: string, lastUsedAt: string) => {
          const value = values.get(key) as
            | { secretHash?: string; revokedAt?: string | null }
            | undefined;
          if (!value || value.secretHash !== expectedSecretHash || value.revokedAt) {
            return Promise.resolve(false);
          }
          values.set(key, { ...value, lastUsedAt });
          return Promise.resolve(true);
        },
      ),
      revokeApiKey: jest.fn(
        (
          key: string,
          ownerId: string,
          revokedAt: string,
          retentionTtlMs: number,
          ownerIndexKey: string,
          member: string,
        ) => {
          const value = values.get(key) as
            | { userId?: string; publicId?: string; revokedAt?: string | null }
            | undefined;
          const expiresAt = expiresAtByKey.get(key);
          if (
            !value ||
            expiresAt === undefined ||
            expiresAt <= Date.now() ||
            value.userId !== ownerId ||
            value.publicId !== member
          ) {
            sets.get(ownerIndexKey)?.delete(member);
            values.delete(key);
            expiresAtByKey.delete(key);
            return Promise.resolve(false);
          }
          const alreadyRevoked = value.revokedAt !== null && value.revokedAt !== undefined;
          values.set(key, { ...value, revokedAt: value.revokedAt ?? revokedAt });
          if (!alreadyRevoked) {
            expiresAtByKey.set(key, Math.min(expiresAt, Date.now() + retentionTtlMs));
          }
          return Promise.resolve(true);
        },
      ),
      removeFromSetAndDelete: jest.fn((setKey: string, member: string, key: string) => {
        sets.get(setKey)?.delete(member);
        values.delete(key);
        return Promise.resolve();
      }),
      addToSet: jest.fn((key: string, member: string) => {
        const members = sets.get(key) ?? new Set<string>();
        members.add(member);
        sets.set(key, members);
        return Promise.resolve();
      }),
      removeFromSet: jest.fn((key: string, member: string) => {
        sets.get(key)?.delete(member);
        return Promise.resolve();
      }),
      getSetMembers: jest.fn((key: string) => Promise.resolve([...(sets.get(key) ?? [])])),
    } as unknown as CacheRepository & Record<string, jest.Mock>;
    protectionUtil = {
      hash: jest.fn((value: string) => createHash('sha256').update(value).digest('hex')),
    } as unknown as jest.Mocked<ProtectionUtil>;
    const customEnvService = {
      get: jest.fn((key: string) => (key === 'JWT_SECRET' ? jwtSecret : undefined)),
      getWithDefault: jest.fn((_key: string, fallback: unknown) => fallback),
    } as unknown as CustomEnvService;
    usersService = {
      findById: jest.fn((userId: bigint) =>
        Promise.resolve({
          id: userId,
          username: `user-${userId}@example.com`,
          status: UserStatus.ACTIVE,
        }),
      ),
    } as unknown as jest.Mocked<UsersService>;
    service = new ApiKeyService(cacheRepository, protectionUtil, customEnvService, usersService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('create', () => {
    it('API 키를 한 번만 반환하고 Redis에는 원문 대신 해시를 저장한다', async () => {
      // Given
      const ownerId = 17n;

      // When
      const result = await service.create(ownerId, {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read', 'relay:write', 'keys:read', 'keys:revoke'],
      });

      // Then
      expect(result).toMatchObject({
        apiKey: expect.stringMatching(/^mhk_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/),
        keyId: 1,
        expiresAt: expect.any(String),
        scopes: expect.arrayContaining(['relay:read', 'relay:write']),
      });
      const serializedWrites = JSON.stringify(cacheRepository.setApiKeyWithQuota.mock.calls);
      const storedRecord = cacheRepository.setApiKeyWithQuota.mock.calls[0][1] as { id: number };
      expect(typeof storedRecord.id).toBe('number');
      const secret = result.apiKey.slice('mhk_'.length + 22 + 1);
      expect(serializedWrites).not.toContain(result.apiKey);
      expect(serializedWrites).not.toContain(secret);
      expect(serializedWrites).toContain(createHash('sha256').update(secret).digest('hex'));
      expect(cacheRepository.setApiKeyWithQuota.mock.calls).toHaveLength(1);
      expect(protectionUtil.hash.mock.calls).toContainEqual([secret]);
      expect(usersService.findById.mock.calls).toContainEqual([ownerId]);
    });

    it('Redis 저장 전 일시적인 실패 뒤 같은 idempotency key로 다시 발급한다', async () => {
      // Given
      const ownerId = 17n;
      const input = {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'] as const,
      };
      const idempotencyKey = Buffer.alloc(32, 1).toString('base64url');
      cacheRepository.setApiKeyWithQuota.mockRejectedValueOnce(
        new Error('Temporary Redis failure before write'),
      );

      // When
      await expect(service.create(ownerId, input, idempotencyKey)).rejects.toThrow(
        'Temporary Redis failure before write',
      );
      expect(values.size).toBe(0);
      const firstSuccessfulIssue = await service.create(ownerId, input, idempotencyKey);
      const retriedIssue = await service.create(ownerId, input, idempotencyKey);

      // Then
      expect(retriedIssue.apiKey).toBe(firstSuccessfulIssue.apiKey);
      expect(retriedIssue.keyId).toBe(firstSuccessfulIssue.keyId);
      expect(cacheRepository.increment.mock.calls).toHaveLength(2);
      expect(cacheRepository.setApiKeyWithQuota.mock.calls).toHaveLength(2);
      expect(sets.get('api-key:owner:17')?.size).toBe(1);
    });

    it('Redis 저장 후 응답이 유실돼도 이미 저장된 idempotent API 키를 반환한다', async () => {
      // Given
      const ownerId = 17n;
      const input = {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'] as const,
      };
      const idempotencyKey = Buffer.alloc(32, 2).toString('base64url');
      cacheRepository.setApiKeyWithQuota.mockImplementationOnce(
        (key: string, value: unknown, ttlMs: number, setKey: string, member: string) => {
          values.set(key, value);
          expiresAtByKey.set(key, Date.now() + ttlMs);
          const members = sets.get(setKey) ?? new Set<string>();
          members.add(member);
          sets.set(setKey, members);
          return Promise.reject(new Error('Redis response lost after commit'));
        },
      );

      // When
      const result = await service.create(ownerId, input, idempotencyKey);
      const retriedResult = await service.create(ownerId, input, idempotencyKey);

      // Then
      expect(result.apiKey).toBe(retriedResult.apiKey);
      expect(result.keyId).toBe(retriedResult.keyId);
      expect(cacheRepository.increment.mock.calls).toHaveLength(1);
      expect(cacheRepository.setApiKeyWithQuota.mock.calls).toHaveLength(1);
      expect(values.size).toBe(1);
      expect(sets.get('api-key:owner:17')?.size).toBe(1);
    });

    it('JWT secret이 바뀐 뒤에도 같은 grant seed로 같은 API 키를 반환한다', async () => {
      // Given
      const ownerId = 17n;
      const input = {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read' as const],
      };
      const grantSeed = Buffer.alloc(32, 3).toString('base64url');
      const firstToken = await service.create(ownerId, input, grantSeed);
      jwtSecret = 'rotated-test-secret-after-authorization';

      // When
      const retriedToken = await service.create(ownerId, input, grantSeed);

      // Then
      expect(retriedToken.apiKey).toBe(firstToken.apiKey);
      expect(retriedToken.keyId).toBe(firstToken.keyId);
      expect(cacheRepository.setApiKeyWithQuota.mock.calls).toHaveLength(1);
      expect(sets.get('api-key:owner:17')?.size).toBe(1);
    });
  });

  it('폐기된 키도 만료 전까지 소유자당 100개 할당량에 포함한다', async () => {
    // Given
    const ownerId = 17n;
    const createdKeys: Array<{ keyId: number }> = [];
    for (let keyNumber = 0; keyNumber < 100; keyNumber += 1) {
      createdKeys.push(
        await service.create(ownerId, {
          name: `Work Mac ${keyNumber}`,
          source: 'cli',
          scopes: ['relay:read'],
        }),
      );
    }
    await service.revoke(ownerId, createdKeys[0].keyId);
    const revokedPublicId = cacheRepository.setApiKeyWithQuota.mock.calls[0][4] as string;
    const revokedRecordKey = `api-key:record:${revokedPublicId}`;
    const revokedRecord = values.get(`api-key:record:${revokedPublicId}`) as {
      revokedAt: string | null;
    };
    const revokedExpiry = expiresAtByKey.get(revokedRecordKey);

    // When
    const error = await service
      .create(ownerId, {
        name: 'One more device',
        source: 'cli',
        scopes: ['relay:read'],
      })
      .catch((caught: unknown) => caught);

    // Then
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect((error as Error).message).toBe(
      'Maximum of 100 API key records may be retained per account; revoked records are removed after 30 days and expired keys are removed automatically.',
    );
    expect(revokedRecord.revokedAt).not.toBeNull();
    expect(revokedExpiry).toBe(Date.now() + revokedApiKeyRetentionMs);
    expect(sets.get('api-key:owner:17')?.size).toBe(100);
    expect(cacheRepository.setApiKeyWithQuota.mock.calls[0][6]).toBe(100);
    expect(cacheRepository.setApiKeyWithQuota.mock.calls).toHaveLength(101);

    // A revoked record stops consuming quota after its shortened TTL expires.
    jest.advanceTimersByTime(revokedApiKeyRetentionMs + 1);
    const replacementKey = await service.create(ownerId, {
      name: 'Replacement device',
      source: 'cli',
      scopes: ['relay:read'],
    });
    expect(replacementKey.keyId).toBe(102);
    expect(values.has(revokedRecordKey)).toBe(false);
    expect(sets.get('api-key:owner:17')?.has(revokedPublicId)).toBe(false);
    expect(sets.get('api-key:owner:17')?.size).toBe(100);
    expect(cacheRepository.setApiKeyWithQuota.mock.calls).toHaveLength(102);
  });

  it('공개 ID 충돌 시 새 키를 만들어 다시 시도한다', async () => {
    // Given
    cacheRepository.setApiKeyWithQuota.mockImplementationOnce(() => Promise.resolve('collision'));

    // When
    const result = await service.create(17n, {
      name: 'Work Mac',
      source: 'cli',
      scopes: ['relay:read'],
    });

    // Then
    expect(result.keyId).toBe(2);
    expect(cacheRepository.setApiKeyWithQuota.mock.calls).toHaveLength(2);
    expect(sets.get('api-key:owner:17')?.size).toBe(1);
  });

  describe('list', () => {
    it('API 키 목록은 요청한 소유자에게만 반환한다', async () => {
      // Given
      const firstOwner = 17n;
      const otherOwner = 18n;
      const createdKey = await service.create(firstOwner, {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'],
      });

      // When
      const ownerKeys = await service.list(firstOwner);
      const otherOwnerKeys = await service.list(otherOwner);

      // Then
      expect(ownerKeys).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: String(createdKey.keyId) })]),
      );
      expect(otherOwnerKeys).toEqual([]);
      expect(ownerKeys[0]).not.toHaveProperty('apiKey');
    });

    it('만료 또는 유실된 키 레코드를 목록에서 발견하면 owner 인덱스와 함께 원자적으로 정리한다', async () => {
      // Given
      const ownerId = 17n;
      await service.create(ownerId, {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'],
      });
      const [recordKey, , , ownerIndexKey, publicId] =
        cacheRepository.setApiKeyWithQuota.mock.calls[0];
      values.delete(recordKey);

      // When
      const keys = await service.list(ownerId);

      // Then
      expect(keys).toEqual([]);
      expect(cacheRepository.removeFromSetAndDelete.mock.calls).toContainEqual([
        ownerIndexKey,
        publicId,
        recordKey,
      ]);
    });

    it('정지된 계정의 API 키 목록 조회를 거부한다', async () => {
      // Given
      usersService.findById.mockResolvedValue({
        id: 17n,
        username: 'owner@example.com',
        status: UserStatus.DEACTIVATED,
      } as never);

      // When / Then
      await expect(service.list(17n)).rejects.toBeInstanceOf(ForbiddenException);
      expect(cacheRepository.getSetMembers.mock.calls).toHaveLength(0);
    });
  });

  describe('revoke', () => {
    it('다른 사용자는 소유자의 API 키를 폐기할 수 없다', async () => {
      // Given
      const ownerId = 17n;
      const otherOwnerId = 18n;
      const createdKey = await service.create(ownerId, {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'],
      });

      // When / Then
      await expect(service.revoke(otherOwnerId, createdKey.keyId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.validate(createdKey.apiKey)).resolves.toMatchObject({ userId: ownerId });
    });

    it('만료 시각이 지난 API 키는 인증에 사용할 수 없다', async () => {
      // Given
      const createdKey = await service.create(17n, {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'],
      });
      const expiresAt = Date.parse(createdKey.expiresAt);
      expect(expiresAt).toBeGreaterThan(Date.now());

      // When
      jest.setSystemTime(expiresAt + 1);

      // Then
      await expect(service.validate(createdKey.apiKey)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('폐기한 API 키는 이후 인증에 사용할 수 없다', async () => {
      // Given
      const ownerId = 17n;
      const createdKey = await service.create(ownerId, {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'],
      });
      const recordKey = String(cacheRepository.setApiKeyWithQuota.mock.calls[0][0]);
      const ownerIndexKey = String(cacheRepository.setApiKeyWithQuota.mock.calls[0][3]);
      const publicId = String(cacheRepository.setApiKeyWithQuota.mock.calls[0][4]);
      const originalExpiresAt = expiresAtByKey.get(recordKey);
      expect(originalExpiresAt).toBeDefined();

      // When
      await service.revoke(ownerId, createdKey.keyId);

      // Then
      expect(cacheRepository.revokeApiKey.mock.calls).toHaveLength(1);
      expect(cacheRepository.revokeApiKey.mock.calls[0]).toEqual([
        recordKey,
        ownerId.toString(),
        expect.any(String),
        revokedApiKeyRetentionMs,
        ownerIndexKey,
        publicId,
      ]);
      expect(expiresAtByKey.get(recordKey)).toBe(
        Math.min(originalExpiresAt!, Date.now() + revokedApiKeyRetentionMs),
      );
      await expect(service.validate(createdKey.apiKey)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(await service.list(ownerId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ revokedAt: expect.any(String) })]),
      );
    });

    it('기존 남은 TTL이 30일보다 짧으면 더 짧은 만료 시각을 유지한다', async () => {
      // Given
      const ownerId = 17n;
      const createdKey = await service.create(ownerId, {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'],
      });
      const recordKey = String(cacheRepository.setApiKeyWithQuota.mock.calls[0][0]);
      const originalExpiresAt = expiresAtByKey.get(recordKey)!;
      jest.advanceTimersByTime(350 * 24 * 60 * 60 * 1000);
      expect(originalExpiresAt - Date.now()).toBeLessThan(revokedApiKeyRetentionMs);

      // When
      await service.revoke(ownerId, createdKey.keyId);

      // Then
      expect(cacheRepository.revokeApiKey.mock.calls[0][3]).toBe(revokedApiKeyRetentionMs);
      expect(expiresAtByKey.get(recordKey)).toBe(originalExpiresAt);
    });

    it('반복 폐기는 기존 revokedAt과 30일 만료 시각을 연장하지 않는다', async () => {
      // Given
      const ownerId = 17n;
      const createdKey = await service.create(ownerId, {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'],
      });
      const recordKey = String(cacheRepository.setApiKeyWithQuota.mock.calls[0][0]);
      await service.revoke(ownerId, createdKey.keyId);
      const firstExpiry = expiresAtByKey.get(recordKey);
      const firstRecord = values.get(recordKey) as { revokedAt: string };
      jest.advanceTimersByTime(5 * 24 * 60 * 60 * 1000);

      // When
      await service.revoke(ownerId, createdKey.keyId);

      // Then
      expect(expiresAtByKey.get(recordKey)).toBe(firstExpiry);
      expect((values.get(recordKey) as { revokedAt: string }).revokedAt).toBe(
        firstRecord.revokedAt,
      );
    });

    it('정지된 계정은 새 API 키를 만들 수 없다', async () => {
      // Given
      usersService.findById.mockResolvedValue({
        id: 17n,
        username: 'owner@example.com',
        status: UserStatus.DEACTIVATED,
      } as never);

      // When / Then
      await expect(
        service.create(17n, {
          name: 'Work Mac',
          source: 'cli',
          scopes: ['relay:read'],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(cacheRepository.increment.mock.calls).toHaveLength(0);
    });

    it('정지된 계정은 기존 API 키를 폐기할 수 없다', async () => {
      // Given
      const createdKey = await service.create(17n, {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'],
      });
      usersService.findById.mockResolvedValue({
        id: 17n,
        username: 'owner@example.com',
        status: UserStatus.DEACTIVATED,
      } as never);

      // When / Then
      await expect(service.revoke(17n, createdKey.keyId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(cacheRepository.revokeApiKey.mock.calls).toHaveLength(0);
    });

    it('정지된 계정의 기존 키를 인증하지 않는다', async () => {
      // Given
      const createdKey = await service.create(17n, {
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'],
      });
      usersService.findById.mockResolvedValue({
        id: 17n,
        username: 'owner@example.com',
        status: UserStatus.DEACTIVATED,
      } as never);

      // When / Then
      await expect(service.validate(createdKey.apiKey)).rejects.toMatchObject({
        message: 'Invalid API key',
      });
    });

    it('키 scope가 비어 있으면 키 생성을 거부한다', async () => {
      // Given / When / Then
      await expect(
        service.create(17n, {
          name: 'Work Mac',
          source: 'cli',
          scopes: [],
        }),
      ).rejects.toMatchObject({ message: 'At least one API key scope is required' });
      expect(cacheRepository.increment.mock.calls).toHaveLength(0);
    });
  });
});
