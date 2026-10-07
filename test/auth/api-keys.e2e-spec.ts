import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { applyHttpConfig } from '../../src/bootstrap/apply-http-config';
import { ApiKeyService } from '../../src/auth/api-key.service';
import { ApiKeysController } from '../../src/auth/api-keys.controller';

type MockRequest = {
  headers: { authorization?: string };
  user?: unknown;
  apiKey?: unknown;
};

describe('GET /api/api-keys', () => {
  let app: INestApplication<App>;
  let apiKeyService: {
    list: jest.Mock;
    revoke: jest.Mock;
    revokeCurrent: jest.Mock;
  };

  beforeAll(async () => {
    apiKeyService = {
      list: jest.fn(),
      revoke: jest.fn(),
      revokeCurrent: jest.fn(),
    };
    const testAuthGuard = {
      canActivate: (context: { switchToHttp: () => { getRequest: () => MockRequest } }) => {
        const incoming = context.switchToHttp().getRequest();
        if (incoming.headers.authorization !== 'Bearer browser-jwt') {
          throw new UnauthorizedException('Access token is required');
        }
        incoming.user = { userId: 17n, username: 'owner@example.com' };
        return true;
      },
    };
    const moduleFixture = await Test.createTestingModule({
      controllers: [ApiKeysController],
      providers: [
        { provide: ApiKeyService, useValue: apiKeyService },
        { provide: APP_GUARD, useValue: testAuthGuard },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    applyHttpConfig(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('브라우저 JWT 사용자 소유의 키 목록을 응답 래퍼에 담아 반환한다', async () => {
    // Given
    const keys = [
      {
        id: '41',
        publicId: '1234567890123456789012',
        name: 'Work Mac',
        source: 'cli',
        scopes: ['relay:read'],
        lastUsedAt: null,
        expiresAt: '2027-10-07T00:00:00.000Z',
        revokedAt: null,
        createdAt: '2026-10-07T00:00:00.000Z',
      },
    ];
    apiKeyService.list.mockResolvedValue(keys);

    // When
    const response = await request(app.getHttpServer())
      .get('/api/api-keys')
      .set('Authorization', 'Bearer browser-jwt')
      .expect(200);

    // Then
    expect(response.body).toEqual({ result: 'success', data: keys });
    expect(apiKeyService.list).toHaveBeenCalledWith(17n);
  });

  it('인증이 없으면 키 목록을 조회하지 않는다', async () => {
    // Given / When
    const response = await request(app.getHttpServer()).get('/api/api-keys').expect(401);

    // Then
    expect(response.body.result).toBe('fail');
    expect(apiKeyService.list).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/api-keys/:keyId', () => {
  let app: INestApplication<App>;
  let apiKeyService: {
    list: jest.Mock;
    revoke: jest.Mock;
    revokeCurrent: jest.Mock;
  };

  beforeAll(async () => {
    apiKeyService = {
      list: jest.fn(),
      revoke: jest.fn(),
      revokeCurrent: jest.fn(),
    };
    const testAuthGuard = {
      canActivate: (context: { switchToHttp: () => { getRequest: () => MockRequest } }) => {
        const incoming = context.switchToHttp().getRequest();
        if (incoming.headers.authorization !== 'Bearer browser-jwt') {
          throw new UnauthorizedException('Access token is required');
        }
        incoming.user = { userId: 17n, username: 'owner@example.com' };
        return true;
      },
    };
    const moduleFixture = await Test.createTestingModule({
      controllers: [ApiKeysController],
      providers: [
        { provide: ApiKeyService, useValue: apiKeyService },
        { provide: APP_GUARD, useValue: testAuthGuard },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    applyHttpConfig(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('키를 현재 JWT 사용자 소유 범위로 폐기한다', async () => {
    // Given
    apiKeyService.revoke.mockResolvedValue(undefined);

    // When
    const response = await request(app.getHttpServer())
      .delete('/api/api-keys/41')
      .set('Authorization', 'Bearer browser-jwt')
      .expect(200);

    // Then
    expect(response.body.result).toBe('success');
    expect(apiKeyService.revoke).toHaveBeenCalledWith(17n, '41');
  });
});

describe('DELETE /api/api-keys/current', () => {
  let app: INestApplication<App>;
  let apiKeyService: {
    list: jest.Mock;
    revoke: jest.Mock;
    revokeCurrent: jest.Mock;
  };

  beforeAll(async () => {
    apiKeyService = {
      list: jest.fn(),
      revoke: jest.fn(),
      revokeCurrent: jest.fn(),
    };
    const apiKeyGuard = {
      canActivate: (context: { switchToHttp: () => { getRequest: () => MockRequest } }) => {
        const incoming = context.switchToHttp().getRequest();
        if (!incoming.headers.authorization?.startsWith('Bearer mhk_')) {
          throw new UnauthorizedException('Access token is required');
        }
        incoming.user = { userId: 17n, username: 'owner@example.com' };
        incoming.apiKey = { keyId: 41 };
        return true;
      },
    };
    const moduleFixture = await Test.createTestingModule({
      controllers: [ApiKeysController],
      providers: [
        { provide: ApiKeyService, useValue: apiKeyService },
        { provide: APP_GUARD, useValue: apiKeyGuard },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    applyHttpConfig(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('현재 CLI 키를 식별해 폐기한다', async () => {
    // Given
    apiKeyService.revokeCurrent.mockResolvedValue(undefined);

    // When
    const response = await request(app.getHttpServer())
      .delete('/api/api-keys/current')
      .set(
        'Authorization',
        'Bearer mhk_1234567890123456789012_1234567890123456789012345678901234567890123',
      )
      .expect(200);

    // Then
    expect(response.body.result).toBe('success');
    expect(apiKeyService.revokeCurrent).toHaveBeenCalledWith(17n, 41);
  });
});
