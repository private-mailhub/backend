import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { CacheRepository } from '../../src/cache/cache.repository';
import { ApiKeyService } from '../../src/auth/api-key.service';
import { CliDeviceAuthService } from '../../src/auth/cli-device-auth.service';
import { UsersService } from '../../src/users/users.service';
import { UserStatus } from '../../src/users/user.enums';

type CacheValue = { value: unknown; expiresAt: number | null };
const testClientIp = '203.0.113.7';

describe('CliDeviceAuthService', () => {
  let service: CliDeviceAuthService;
  let cacheRepository: CacheRepository & Record<string, jest.Mock>;
  let apiKeyService: jest.Mocked<ApiKeyService>;
  let usersService: jest.Mocked<UsersService>;
  let values: Map<string, CacheValue>;
  let counters: Map<string, { count: number; expiresAt: number }>;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
    values = new Map();
    counters = new Map();
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

    const customEnvService = {
      get: jest.fn((key: string) => {
        return key === 'JWT_SECRET' ? 'stable-test-secret-for-cli-device-auth' : undefined;
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
      const storedState = JSON.stringify([...values.entries()]);
      expect(storedState).not.toContain(result.deviceCode);
      expect(storedState).not.toContain(result.userCode);
    });

    it('같은 IP에서 기기 인증 요청이 10회를 넘으면 인증 시도를 제한한다', async () => {
      // Given
      const input = {
        clientName: 'mailhub-cli',
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
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );

      // When
      await service.decideAuthorization(7n, authorization.userCode, false, testClientIp);

      // Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testClientIp),
      ).rejects.toMatchObject({ message: 'access_denied' });
      expect(apiKeyService.create.mock.calls).toHaveLength(0);
    });

    it('다른 사용자 소유로 이미 연결된 승인 요청은 다시 승인할 수 없다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
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
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );

      // When / Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testClientIp),
      ).rejects.toMatchObject({ message: 'authorization_pending' });
      expect(cacheRepository.getAndDelete.mock.calls).toHaveLength(0);
    });

    it('같은 IP에서 폴링이 20회를 넘으면 slow_down을 반환하고 pending 요청은 유지한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        '198.51.100.15',
      );
      for (let requestNumber = 0; requestNumber < 20; requestNumber += 1) {
        await expect(
          service.pollDeviceToken(authorization.deviceCode, testClientIp),
        ).rejects.toMatchObject({ message: 'authorization_pending' });
      }

      // When / Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testClientIp),
      ).rejects.toMatchObject({ message: 'slow_down' });
      expect(cacheRepository.getAndDelete.mock.calls).toHaveLength(0);
    });

    it('pending 폴링은 승인 상태를 보존해 이후 승인 후 토큰을 발급한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );

      // When
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testClientIp),
      ).rejects.toMatchObject({ message: 'authorization_pending' });
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);
      const token = await service.pollDeviceToken(authorization.deviceCode, testClientIp);

      // Then
      expect(token.apiKey).toMatch(/^mhk_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
      expect(apiKeyService.create.mock.calls).toHaveLength(1);
    });

    it('승인된 요청은 형식이 맞는 API 키를 한 번만 반환한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);

      // When
      const token = await service.pollDeviceToken(authorization.deviceCode, testClientIp);

      // Then
      expect(token).toMatchObject({
        apiKey: expect.stringMatching(/^mhk_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/),
        keyId: '41',
        expiresAt: expect.any(String),
        scopes: expect.arrayContaining(['relay:read']),
      });
      expect(typeof token.keyId).toBe('string');
      expect(apiKeyService.create.mock.calls).toHaveLength(1);
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      expect(apiKeyService.create.mock.calls).toHaveLength(1);
    });

    it('키 할당량 초과 후 승인 상태를 복구해 재시도를 허용한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
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
        service.pollDeviceToken(authorization.deviceCode, testClientIp),
      ).rejects.toBeInstanceOf(ConflictException);
      const stateEntry = [...values.entries()].find(([key]) => key.startsWith('cli:device:state:'));
      const token = await service.pollDeviceToken(authorization.deviceCode, testClientIp);

      // Then
      expect((stateEntry?.[1].value as { status: string } | undefined)?.status).toBe('approved');
      expect(token.keyId).toBe('41');
      expect(apiKeyService.create.mock.calls).toHaveLength(2);
    });

    it('만료된 요청은 expired_token을 반환한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      jest.advanceTimersByTime(601_000);

      // When / Then
      await expect(
        service.pollDeviceToken(authorization.deviceCode, testClientIp),
      ).rejects.toMatchObject({ message: 'expired_token' });
      expect(apiKeyService.create.mock.calls).toHaveLength(0);
    });

    it('동시에 폴링해도 API 키는 한 번만 발급한다', async () => {
      // Given
      const authorization = await service.startDeviceAuthorization(
        {
          clientName: 'mailhub-cli',
          deviceName: 'Work Mac',
          cliVersion: '0.1.0',
        },
        testClientIp,
      );
      await service.decideAuthorization(7n, authorization.userCode, true, testClientIp);

      // When
      const results = await Promise.allSettled([
        service.pollDeviceToken(authorization.deviceCode, testClientIp),
        service.pollDeviceToken(authorization.deviceCode, testClientIp),
      ]);

      // Then
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(apiKeyService.create.mock.calls).toHaveLength(1);
    });
  });
});
