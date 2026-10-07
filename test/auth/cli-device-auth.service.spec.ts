import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { CacheRepository } from '../../src/cache/cache.repository';
import { ApiKeyService } from '../../src/auth/api-key.service';
import { CliDeviceAuthService } from '../../src/auth/cli-device-auth.service';
import { ProtectionUtil } from '../../src/common/utils/protection.util';
import { UsersService } from '../../src/users/users.service';
import { UserStatus } from '../../src/users/user.enums';

type CacheValue = { value: unknown; expiresAt: number | null };
const testClientIp = '203.0.113.7';
const testPollSecret = Buffer.alloc(32, 7).toString('base64url');
const wrongPollSecret = Buffer.alloc(32, 8).toString('base64url');
const malformedPollSecret = `${'A'.repeat(42)}B`;
const testPollSecretHash = createHash('sha256').update(testPollSecret).digest('hex');

describe('CliDeviceAuthService', () => {
  let service: CliDeviceAuthService;
  let cacheRepository: CacheRepository & Record<string, jest.Mock>;
  let apiKeyService: jest.Mocked<ApiKeyService>;
  let protectionUtil: jest.Mocked<ProtectionUtil>;
  let usersService: jest.Mocked<UsersService>;
  let values: Map<string, CacheValue>;
  let counters: Map<string, { count: number; expiresAt: number }>;
  let encryptedSeeds: Map<string, string>;
  let deviceAuthorizationSecret: string;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
    values = new Map();
    counters = new Map();
    encryptedSeeds = new Map();
    deviceAuthorizationSecret = 'stable-test-secret-for-cli-device-auth';
    let encryptedSeedSequence = 0;
    let sequence = 0;
    cacheRepository = {
      set: jest.fn((key: string, value: unknown, ttl?: number) => {
        values.set(key, {
          value,
          expiresAt: ttl === undefined ? null : Date.now() + ttl,
        });
        return Promise.resolve();
      }),
      get: jest.fn((key: string) => {
        const entry = values.get(key);
        if (!entry || (entry.expiresAt !== null && entry.expiresAt <= Date.now())) {
          values.delete(key);
          return Promise.resolve(null);
        }
        return Promise.resolve(entry.value);
      }),
      del: jest.fn((key: string) => {
        values.delete(key);
        return Promise.resolve();
      }),
      getAndDelete: jest.fn((key: string) => {
        const entry = values.get(key);
        if (!entry || (entry.expiresAt !== null && entry.expiresAt <= Date.now())) {
          values.delete(key);
          return Promise.resolve(null);
        }
        values.delete(key);
        return Promise.resolve(entry.value);
      }),
      increment: jest.fn(() => Promise.resolve(++sequence)),
      incrementWithExpiry: jest.fn((key: string, ttlMs: number) => {
        let entry = counters.get(key);
        if (!entry || entry.expiresAt <= Date.now()) {
          entry = { count: 0, expiresAt: Date.now() + ttlMs };
        }
        entry.count += 1;
        counters.set(key, entry);
        return Promise.resolve(entry.count);
      }),
      setManyWithExpiry: jest.fn(
        (entries: Array<{ key: string; value: unknown; ttlMs: number }>) => {
          entries.forEach(({ key, value, ttlMs }) => {
            values.set(key, { value, expiresAt: Date.now() + ttlMs });
          });
          return Promise.resolve();
        },
      ),
      setManyIfAbsentWithExpiry: jest.fn(
        (entries: Array<{ key: string; value: unknown; ttlMs: number }>) => {
          const collision = entries.some(({ key }) => {
            const entry = values.get(key);
            return entry && (entry.expiresAt === null || entry.expiresAt > Date.now());
          });
          if (collision) {
            return Promise.resolve(false);
          }
          entries.forEach(({ key, value, ttlMs }) => {
            values.set(key, { value, expiresAt: Date.now() + ttlMs });
          });
          return Promise.resolve(true);
        },
      ),
      setAndAddToSet: jest.fn(
        (key: string, value: unknown, ttlMs: number, _setKey: string, _member: string) => {
          values.set(key, { value, expiresAt: Date.now() + ttlMs });
          return Promise.resolve();
        },
      ),
      transitionJson: jest.fn((key: string, expectedStatus: string, nextValue: unknown) => {
        const entry = values.get(key);
        const value = entry?.value as { status?: string } | undefined;
        if (!entry || value?.status !== expectedStatus) {
          return Promise.resolve(false);
        }
        values.set(key, { ...entry, value: nextValue });
        return Promise.resolve(true);
      }),
      removeFromSetAndDelete: jest.fn((_setKey: string, _member: string, key: string) => {
        values.delete(key);
        return Promise.resolve();
      }),
    } as unknown as CacheRepository & Record<string, jest.Mock>;
    apiKeyService = {
      create: jest.fn().mockResolvedValue({
        apiKey: 'mhk_1234567890123456789012_1234567890123456789012345678901234567890123',
        keyId: 41,
        expiresAt: '2027-10-07T00:00:00.000Z',
        scopes: ['relay:read', 'relay:write', 'keys:read', 'keys:revoke'],
      }),
    } as unknown as jest.Mocked<ApiKeyService>;

    protectionUtil = {
      encrypt: jest.fn((seed: string) => {
        const encryptedSeed = `encrypted-grant-seed-${++encryptedSeedSequence}`;
        encryptedSeeds.set(encryptedSeed, seed);
        return encryptedSeed;
      }),
      decrypt: jest.fn((encryptedSeed: string) => {
        const seed = encryptedSeeds.get(encryptedSeed);
        if (!seed) {
          throw new Error('Grant seed could not be decrypted');
        }
        return seed;
      }),
    } as unknown as jest.Mocked<ProtectionUtil>;

    const customEnvService = {
      get: jest.fn((key: string) => {
        return key === 'JWT_SECRET' ? deviceAuthorizationSecret : undefined;
      }),
      getWithDefault: jest.fn((key: string, fallback: string) =>
        key === 'CLI_DEVICE_VERIFICATION_URI'
          ? 'https://private-mailhub.com/cli/authorize'
          : fallback,
      ),
    };
    usersService = {
      findById: jest.fn((userId: bigint) =>
        Promise.resolve({
          id: userId,
          username: `user-${userId}@example.com`,
          status: UserStatus.ACTIVE,
        }),
      ),
    } as unknown as jest.Mocked<UsersService>;
    service = new CliDeviceAuthService(
      cacheRepository,
      apiKeyService,
      protectionUtil,
      customEnvService as never,
      usersService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('startDeviceAuthorization', () => {
    it('기기 코드를 발급하고 CLI 승인 정보를 반환한다', async () => {
      // Given
      const input = {
        clientName: 'mailhub-cli',
        pollSecretHash: testPollSecretHash,
        deviceName: 'Work Mac',
        cliVersion: '0.1.0',
      };

      // When
      const result = await service.startDeviceAuthorization(input, testClientIp);

      // Then
      expect(result).toMatchObject({
        verificationUri: 'https://private-mailhub.com/cli/authorize',
        expiresIn: expect.any(Number),
        interval: expect.any(Number),
      });
      expect(result.deviceCode).toEqual(expect.any(String));
      expect(result.userCode).toEqual(expect.any(String));
      expect(result.deviceCode).not.toBe(result.userCode);
      expect(result).not.toHaveProperty('pollSecretHash');
      const storedState = JSON.stringify([...values.entries()]);
      expect(storedState).not.toContain(result.deviceCode);
      expect(storedState).not.toContain(result.userCode);
      expect(storedState).not.toContain(testPollSecret);
      expect(storedState).toContain(testPollSecretHash);
    });

    it('같은 IP에서 기기 인증 요청이 10회를 넘으면 인증 시도를 제한한다', async () => {
      // Given
      const input = {
        clientName: 'mailhub-cli',
        pollSecretHash: testPollSecretHash,
        deviceName: 'Work Mac',
        cliVersion: '0.1.0',
      };
      for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
        await service.startDeviceAuthorization(input, testClientIp);
      }

      // When / Then
      const error = await service
        .startDeviceAuthorization(input, testClientIp)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((error as Error).message).toBe('Too many authorization attempts');
      expect(cacheRepository.incrementWithExpiry.mock.calls.length).toBeGreaterThan(0);
      await expect(service.startDeviceAuthorization(input, '203.0.113.8')).resolves.toMatchObject({
        deviceCode: expect.any(String),
      });
    });
  });

  describe('getAuthorization', () => {
    it('사용자 코드로 민감한 기기 코드를 제외한 승인 정보를 반환한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );

      // When
      const result = await service.getAuthorization(authorization.userCode, testClientIp);

      // Then
      expect(result).toMatchObject({
        clientName: 'mailhub-cli',
        deviceName: 'Work Mac',
        cliVersion: '0.1.0',
        status: 'pending',
        expiresAt: expect.any(String),
        scopes: expect.arrayContaining(['relay:read', 'relay:write']),
      });
      expect(result).not.toHaveProperty('deviceCode');
    });

    it('존재하지 않거나 만료된 사용자 코드는 찾을 수 없다고 반환한다', async () => {
      // Given
      const unknownCode = 'XXXX-XXXX';

      // When / Then
      await expect(service.getAuthorization(unknownCode, testClientIp)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('같은 IP에서 사용자 코드 조회가 10회를 넘으면 rate limit을 적용한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        '198.51.100.15',
      );
      for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
        await service.getAuthorization(authorization.userCode, testClientIp);
      }

      // When / Then
      const error = await service
        .getAuthorization(authorization.userCode, testClientIp)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((error as Error).message).toBe('Too many authorization attempts');
    });

    it('사용자 코드 조회와 승인 결정은 같은 IP별 요청 제한을 공유한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        '198.51.100.15',
      );
      for (let requestNumber = 0; requestNumber < 5; requestNumber += 1) {
        await service.getAuthorization(authorization.userCode, testClientIp);
      }

      // When
      for (let requestNumber = 0; requestNumber < 5; requestNumber += 1) {
        await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      }
      const error = await service
        .getAuthorization(authorization.userCode, testClientIp)
        .catch((caught: unknown) => caught);

      // Then
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((error as Error).message).toBe('Too many authorization attempts');
    });
  });

  describe('decideAuthorization', () => {
    it('승인한 사용자에게만 해당 기기 요청을 연결한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );

      // When
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      const result = await service.getAuthorization(authorization.userCode, testClientIp);

      // Then
      expect(result).toMatchObject({ status: 'approved' });
      expect(result).not.toHaveProperty('userId');
      expect(usersService.findById.mock.calls).toContainEqual([7n]);
    });

    it('거부된 요청은 토큰 발급 대신 access_denied를 반환한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );

      // When
      await service.decideAuthorization(7n, authorization.userCode, false, testClientIp);

      // Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'access_denied' });
      expect(apiKeyService.create.mock.calls).toHaveLength(0);
    });

    it('다른 사용자 소유로 이미 연결된 승인 요청은 다시 승인할 수 없다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);

      // When / Then
      await expect(
        service.decideAuthorization(8n, authorization.userCode, true, testClientIp),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('정지된 계정은 기기 인증 요청을 승인할 수 없다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        '198.51.100.15',
      );
      usersService.findById.mockResolvedValue({
        id: 7n,
        username: 'owner@example.com',
        status: UserStatus.DEACTIVATED,
      } as never);

      // When / Then
      await expect(
        service.decideAuthorization(7n, authorization.userCode, true, testClientIp),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(cacheRepository.transitionJson.mock.calls).toHaveLength(0);
    });
  });

  describe('pollDeviceToken', () => {
    it('승인 전에는 authorization_pending을 반환한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );

      // When / Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'authorization_pending' });
      expect(cacheRepository.getAndDelete.mock.calls).toHaveLength(0);
    });

    it('pending 요청은 틀리거나 빠진 pollSecret에 상태를 노출하지 않는다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );

      // When / Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, wrongPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      await expect(
        service.pollDeviceToken(authorization.deviceCode, undefined as never, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      await expect(
        service.pollDeviceToken(authorization.deviceCode, malformedPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      expect(apiKeyService.create.mock.calls).toHaveLength(0);
      expect(cacheRepository.transitionJson.mock.calls).toHaveLength(0);
    });

    it('승인된 요청은 틀리거나 빠진 pollSecret에 발급을 시작하지 않는다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      const transitionCountAfterApproval = cacheRepository.transitionJson.mock.calls.length;

      // When / Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, wrongPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      await expect(
        service.pollDeviceToken(authorization.deviceCode, undefined as never, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      expect(cacheRepository.transitionJson.mock.calls).toHaveLength(transitionCountAfterApproval);
      expect(apiKeyService.create.mock.calls).toHaveLength(0);
    });

    it('소비된 deviceCode만으로는 API 키를 다시 가져올 수 없다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      const issuedToken = await service.pollDeviceToken(
        authorization.deviceCode,
        testPollSecret,
        testClientIp,
      );

      // When / Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, wrongPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      await expect(
        service.pollDeviceToken(authorization.deviceCode, undefined as never, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      expect(issuedToken.apiKey).toMatch(/^mhk_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
      expect(apiKeyService.create.mock.calls).toHaveLength(1);
    });

    it('같은 IP에서 폴링이 20회를 넘으면 slow_down을 반환하고 pending 요청은 유지한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        '198.51.100.15',
      );
      for (let requestNumber = 0; requestNumber < 20; requestNumber += 1) {
        await expect(
          service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
        ).rejects.toMatchObject({ message: 'authorization_pending' });
      }

      // When / Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'slow_down' });
      expect(cacheRepository.getAndDelete.mock.calls).toHaveLength(0);
    });

    it('pending 폴링은 승인 상태를 보존해 이후 승인 후 토큰을 발급한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );

      // When
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'authorization_pending' });
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      const token = await service.pollDeviceToken(
        authorization.deviceCode,
        testPollSecret,
        testClientIp,
      );

      // Then
      expect(token.apiKey).toMatch(/^mhk_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
      expect(apiKeyService.create.mock.calls).toHaveLength(1);
    });

    it('승인된 요청은 60초 동안 같은 API 키를 반환하고 이후 재사용을 거부한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);

      // When
      const token = await service.pollDeviceToken(
        authorization.deviceCode,
        testPollSecret,
        testClientIp,
      );

      // Then
      expect(token).toMatchObject({
        apiKey: expect.stringMatching(/^mhk_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/),
        keyId: '41',
        expiresAt: expect.any(String),
        scopes: expect.arrayContaining(['relay:read']),
      });
      expect(typeof token.keyId).toBe('string');
      expect(apiKeyService.create.mock.calls).toHaveLength(1);
      const retryToken = await service.pollDeviceToken(
        authorization.deviceCode,
        testPollSecret,
        testClientIp,
      );
      expect(retryToken.apiKey).toBe(token.apiKey);
      expect(retryToken.keyId).toBe(token.keyId);
      expect(apiKeyService.create.mock.calls).toHaveLength(2);

      // The original authorization lifetime is longer than the consumed-key recovery window.
      jest.advanceTimersByTime(60_001);
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      expect(apiKeyService.create.mock.calls).toHaveLength(2);
    });

    it('키 할당량 초과 뒤 issuing 상태와 seed를 보존해 재시도를 허용한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      apiKeyService.create.mockRejectedValueOnce(
        new ConflictException(
          'Maximum of 100 API key records may be retained per account; revoked records are removed after 30 days and expired keys are removed automatically.',
        ),
      );

      // When
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ).rejects.toBeInstanceOf(ConflictException);
      const stateKey = [...values.keys()].find((key) => key.startsWith('cli:device:state:'));
      const issuingState = values.get(stateKey!)?.value as {
        status: string;
        encryptedIdempotencySeed: string | null;
      };
      expect(issuingState.status).toBe('issuing');
      expect(issuingState.encryptedIdempotencySeed).toMatch(/^encrypted-grant-seed-/);
      const token = await service.pollDeviceToken(
        authorization.deviceCode,
        testPollSecret,
        testClientIp,
      );

      // Then
      expect((values.get(stateKey!)?.value as { status: string } | undefined)?.status).toBe(
        'consumed',
      );
      expect(token.keyId).toBe('41');
      expect(apiKeyService.create.mock.calls).toHaveLength(2);
    });

    it('일시적인 키 발급 실패 뒤 issuing 상태를 이어서 같은 idempotency key로 재시도한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      apiKeyService.create.mockRejectedValueOnce(new Error('Temporary key service failure'));

      // When
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ).rejects.toThrow('Temporary key service failure');
      const stateKey = [...values.keys()].find((key) => key.startsWith('cli:device:state:'));
      expect((values.get(stateKey!)?.value as { status: string } | undefined)?.status).toBe(
        'issuing',
      );
      const issuingState = values.get(stateKey!)?.value as {
        encryptedIdempotencySeed?: string;
      };
      expect(issuingState.encryptedIdempotencySeed).toMatch(/^encrypted-grant-seed-/);
      const firstIdempotencySeed = apiKeyService.create.mock.calls[0][2] as string;
      expect(Buffer.from(firstIdempotencySeed, 'base64url')).toHaveLength(32);
      expect(JSON.stringify(issuingState)).not.toContain(firstIdempotencySeed);
      expect(encryptedSeeds.get(issuingState.encryptedIdempotencySeed!)).toBe(firstIdempotencySeed);
      deviceAuthorizationSecret = 'rotated-test-secret-during-token-retry';
      const token = await service.pollDeviceToken(
        authorization.deviceCode,
        testPollSecret,
        testClientIp,
      );

      // Then
      expect(token.keyId).toBe('41');
      expect(apiKeyService.create.mock.calls).toHaveLength(2);
      const idempotencyKeys = apiKeyService.create.mock.calls.map(([, , idempotencyKey]) =>
        String(idempotencyKey),
      );
      expect(Buffer.from(idempotencyKeys[0], 'base64url')).toHaveLength(32);
      expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
      expect((values.get(stateKey!)?.value as { status: string } | undefined)?.status).toBe(
        'consumed',
      );
    });

    it('최종 상태 전환을 재시도해 이미 발급된 키를 같은 결과로 반환한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      const originalTransition = cacheRepository.transitionJson.getMockImplementation() as (
        key: string,
        expectedStatus: string,
        nextValue: unknown,
      ) => Promise<boolean>;
      let failFinalTransition = true;
      cacheRepository.transitionJson.mockImplementation((key, expectedStatus, nextValue) => {
        const nextStatus = (nextValue as { status?: string }).status;
        if (failFinalTransition && expectedStatus === 'issuing' && nextStatus === 'consumed') {
          failFinalTransition = false;
          return Promise.resolve(false);
        }
        return originalTransition(key, expectedStatus, nextValue);
      });

      // When
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'Could not complete device authorization' });
      const stateKey = [...values.keys()].find((key) => key.startsWith('cli:device:state:'));
      expect((values.get(stateKey!)?.value as { status: string } | undefined)?.status).toBe(
        'issuing',
      );
      const retriedToken = await service.pollDeviceToken(
        authorization.deviceCode,
        testPollSecret,
        testClientIp,
      );

      // Then
      expect(retriedToken.apiKey).toMatch(/^mhk_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
      expect(retriedToken.keyId).toBe('41');
      expect(apiKeyService.create.mock.calls).toHaveLength(2);
      expect(apiKeyService.create.mock.calls[1][2]).toBe(apiKeyService.create.mock.calls[0][2]);
      expect((values.get(stateKey!)?.value as { status: string } | undefined)?.status).toBe(
        'consumed',
      );
    });

    it('소비 전환 응답이 유실된 뒤 이미 소비된 상태에서 같은 키 발급을 복구한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      const originalTransition = cacheRepository.transitionJson.getMockImplementation() as (
        key: string,
        expectedStatus: string,
        nextValue: unknown,
      ) => Promise<boolean>;
      let loseFinalResponse = true;
      cacheRepository.transitionJson.mockImplementation((key, expectedStatus, nextValue) => {
        const nextStatus = (nextValue as { status?: string }).status;
        if (loseFinalResponse && expectedStatus === 'issuing' && nextStatus === 'consumed') {
          loseFinalResponse = false;
          return originalTransition(key, expectedStatus, nextValue).then(() => {
            return Promise.reject(new Error('Redis response lost after consume commit'));
          });
        }
        return originalTransition(key, expectedStatus, nextValue);
      });

      // When
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ).rejects.toThrow('Redis response lost after consume commit');
      const recoveredToken = await service.pollDeviceToken(
        authorization.deviceCode,
        testPollSecret,
        testClientIp,
      );

      // Then
      expect(recoveredToken.keyId).toBe('41');
      expect(apiKeyService.create.mock.calls).toHaveLength(2);
      expect(apiKeyService.create.mock.calls[1][2]).toBe(apiKeyService.create.mock.calls[0][2]);
      const stateKey = [...values.keys()].find((key) => key.startsWith('cli:device:state:'));
      expect((values.get(stateKey!)?.value as { status: string } | undefined)?.status).toBe(
        'consumed',
      );
    });

    it('승인 상태 전환에서 같은 사용자의 동시 폴링이 먼저 소비한 키를 복구한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      const concurrentWinnerSeed = Buffer.alloc(32, 4).toString('base64url');
      const encryptedConcurrentWinnerSeed = protectionUtil.encrypt(concurrentWinnerSeed);
      const originalTransition = cacheRepository.transitionJson.getMockImplementation() as (
        key: string,
        expectedStatus: string,
        nextValue: unknown,
      ) => Promise<boolean>;
      cacheRepository.transitionJson.mockImplementation((key, expectedStatus, nextValue) => {
        if (
          expectedStatus === 'approved' &&
          (nextValue as { status?: string }).status === 'issuing'
        ) {
          const current = values.get(key);
          if (current) {
            values.set(key, {
              ...current,
              value: {
                ...(current.value as object),
                status: 'consumed',
                consumedAt: new Date().toISOString(),
                encryptedIdempotencySeed: encryptedConcurrentWinnerSeed,
              },
            });
          }
          return Promise.resolve(false);
        }
        return originalTransition(key, expectedStatus, nextValue);
      });

      // When
      const token = await service.pollDeviceToken(
        authorization.deviceCode,
        testPollSecret,
        testClientIp,
      );

      // Then
      expect(token.keyId).toBe('41');
      expect(apiKeyService.create.mock.calls).toHaveLength(1);
      expect(apiKeyService.create.mock.calls[0][2]).toBe(concurrentWinnerSeed);
      const stateKey = [...values.keys()].find((key) => key.startsWith('cli:device:state:'));
      expect((values.get(stateKey!)?.value as { status: string } | undefined)?.status).toBe(
        'consumed',
      );
    });

    it('만료된 요청은 expired_token을 반환한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      jest.advanceTimersByTime(601_000);

      // When / Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      expect(apiKeyService.create.mock.calls).toHaveLength(0);
    });

    it('동시 폴링은 같은 idempotent API 키와 키 ID를 반환한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          pollSecretHash: testPollSecretHash,
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);

      // When
      const results = await Promise.all([
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
        service.pollDeviceToken(authorization.deviceCode, testPollSecret, testClientIp),
      ]);

      // Then
      expect(results[0].apiKey).toBe(results[1].apiKey);
      expect(results[0].keyId).toBe(results[1].keyId);
      expect(apiKeyService.create.mock.calls).toHaveLength(2);
      expect(
        Buffer.from(apiKeyService.create.mock.calls[0][2] as string, 'base64url'),
      ).toHaveLength(32);
      expect(apiKeyService.create.mock.calls[1][2]).toBe(apiKeyService.create.mock.calls[0][2]);
    });
  });
});
