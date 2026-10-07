import { BadRequestException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { applyHttpConfig } from '../../src/bootstrap/apply-http-config';
import { CliAuthController } from '../../src/auth/cli-auth.controller';
import { CliDeviceAuthService } from '../../src/auth/cli-device-auth.service';

type MockRequest = {
  method: string;
  path?: string;
  headers: { authorization?: string };
  user?: unknown;
};

describe('POST /api/auth/cli/device', () => {
  let app: INestApplication<App>;
  let cliDeviceAuthService: {
    startDeviceAuthorization: jest.Mock;
    getAuthorization: jest.Mock;
    decideAuthorization: jest.Mock;
    pollDeviceToken: jest.Mock;
  };

  beforeAll(async () => {
    cliDeviceAuthService = {
      startDeviceAuthorization: jest.fn(),
      getAuthorization: jest.fn(),
      decideAuthorization: jest.fn(),
      pollDeviceToken: jest.fn(),
    };

    const browserJwtGuard = {
      canActivate: (context: { switchToHttp: () => { getRequest: () => MockRequest } }) => {
        const incoming = context.switchToHttp().getRequest();
        const isPublicEndpoint =
          incoming.method === 'POST' &&
          (incoming.path === '/api/auth/cli/device' ||
            incoming.path === '/api/auth/cli/device/token');
        if (isPublicEndpoint) {
          return true;
        }
        if (incoming.headers.authorization !== 'Bearer browser-jwt') {
          throw new UnauthorizedException('Access token is required');
        }
        incoming.user = { userId: 17n, username: 'owner@example.com' };
        return true;
      },
    };

    const moduleFixture = await Test.createTestingModule({
      controllers: [CliAuthController],
      providers: [
        { provide: CliDeviceAuthService, useValue: cliDeviceAuthService },
        { provide: APP_GUARD, useValue: browserJwtGuard },
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

  it('기기 인증 시작 요청을 서비스로 전달하고 CLI 응답 계약을 반환한다', async () => {
    // Given
    const requestBody = {
      clientName: 'mailhub-cli',
      deviceName: 'Work Mac',
      cliVersion: '0.1.0',
    };
    const authorization = {
      deviceCode: 'device-secret',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://private-mailhub.com/cli/authorize',
      expiresIn: 600,
      interval: 5,
    };
    cliDeviceAuthService.startDeviceAuthorization.mockResolvedValue(authorization);

    // When
    const response = await request(app.getHttpServer())
      .post('/api/auth/cli/device')
      .send(requestBody)
      .expect(201);

    // Then
    expect(response.body).toEqual({ result: 'success', data: authorization });
    expect(cliDeviceAuthService.startDeviceAuthorization).toHaveBeenCalledWith(
      requestBody,
      expect.any(String),
    );
  });
});

describe('POST /api/auth/cli/device/authorization', () => {
  let app: INestApplication<App>;
  let cliDeviceAuthService: {
    startDeviceAuthorization: jest.Mock;
    getAuthorization: jest.Mock;
    decideAuthorization: jest.Mock;
    pollDeviceToken: jest.Mock;
  };

  beforeAll(async () => {
    cliDeviceAuthService = {
      startDeviceAuthorization: jest.fn(),
      getAuthorization: jest.fn(),
      decideAuthorization: jest.fn(),
      pollDeviceToken: jest.fn(),
    };
    const browserJwtGuard = {
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
      controllers: [CliAuthController],
      providers: [
        { provide: CliDeviceAuthService, useValue: cliDeviceAuthService },
        { provide: APP_GUARD, useValue: browserJwtGuard },
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

  it('JWT가 있는 사용자는 기기 승인 정보를 POST 본문으로 조회한다', async () => {
    // Given
    const authorization = {
      clientName: 'mailhub-cli',
      deviceName: 'Work Mac',
      cliVersion: '0.1.0',
      status: 'pending',
      expiresAt: '2026-10-07T00:10:00.000Z',
      scopes: ['relay:read', 'relay:write'],
    };
    cliDeviceAuthService.getAuthorization.mockResolvedValue(authorization);

    // When
    const response = await request(app.getHttpServer())
      .post('/api/auth/cli/device/authorization')
      .set('Authorization', 'Bearer browser-jwt')
      .send({ userCode: 'ABCD-EFGH' })
      .expect(200);

    // Then
    expect(response.body).toEqual({ result: 'success', data: authorization });
    expect(response.body.data).not.toHaveProperty('deviceCode');
    expect(cliDeviceAuthService.getAuthorization).toHaveBeenCalledWith(
      'ABCD-EFGH',
      expect.any(String),
    );
  });

  it('사용자 코드를 URL query로 전달하면 조회에 사용하지 않는다', async () => {
    // Given
    const privateCode = 'ABCD-EFGH';

    // When
    await request(app.getHttpServer())
      .post('/api/auth/cli/device/authorization')
      .set('Authorization', 'Bearer browser-jwt')
      .query({ userCode: privateCode })
      .expect(400);

    // Then
    expect(cliDeviceAuthService.getAuthorization).not.toHaveBeenCalledWith(privateCode);
  });

  it('브라우저 JWT가 없으면 승인 정보를 조회하지 않는다', async () => {
    // Given / When
    const response = await request(app.getHttpServer())
      .post('/api/auth/cli/device/authorization')
      .send({ userCode: 'ABCD-EFGH' })
      .expect(401);

    // Then
    expect(response.body).toEqual({ result: 'fail', data: 'Access token is required' });
    expect(cliDeviceAuthService.getAuthorization).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/cli/device/decision', () => {
  let app: INestApplication<App>;
  let cliDeviceAuthService: {
    startDeviceAuthorization: jest.Mock;
    getAuthorization: jest.Mock;
    decideAuthorization: jest.Mock;
    pollDeviceToken: jest.Mock;
  };

  beforeAll(async () => {
    cliDeviceAuthService = {
      startDeviceAuthorization: jest.fn(),
      getAuthorization: jest.fn(),
      decideAuthorization: jest.fn(),
      pollDeviceToken: jest.fn(),
    };
    const browserJwtGuard = {
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
      controllers: [CliAuthController],
      providers: [
        { provide: CliDeviceAuthService, useValue: cliDeviceAuthService },
        { provide: APP_GUARD, useValue: browserJwtGuard },
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

  it('승인 여부를 현재 JWT 사용자와 함께 서비스에 전달한다', async () => {
    // Given
    cliDeviceAuthService.decideAuthorization.mockResolvedValue({ status: 'approved' });

    // When
    const response = await request(app.getHttpServer())
      .post('/api/auth/cli/device/decision')
      .set('Authorization', 'Bearer browser-jwt')
      .send({ userCode: 'ABCD-EFGH', approve: true })
      .expect(200);

    // Then
    expect(response.body).toEqual({ result: 'success', data: { status: 'approved' } });
    expect(cliDeviceAuthService.decideAuthorization).toHaveBeenCalledWith(
      17n,
      'ABCD-EFGH',
      true,
      expect.any(String),
    );
  });

  it('거부를 선택하면 denied 상태를 응답한다', async () => {
    // Given
    cliDeviceAuthService.decideAuthorization.mockResolvedValue({ status: 'denied' });

    // When
    const response = await request(app.getHttpServer())
      .post('/api/auth/cli/device/decision')
      .set('Authorization', 'Bearer browser-jwt')
      .send({ userCode: 'ABCD-EFGH', approve: false })
      .expect(200);

    // Then
    expect(response.body).toEqual({ result: 'success', data: { status: 'denied' } });
    expect(cliDeviceAuthService.decideAuthorization).toHaveBeenCalledWith(
      17n,
      'ABCD-EFGH',
      false,
      expect.any(String),
    );
  });
});

describe('POST /api/auth/cli/device/token', () => {
  let app: INestApplication<App>;
  let cliDeviceAuthService: {
    startDeviceAuthorization: jest.Mock;
    getAuthorization: jest.Mock;
    decideAuthorization: jest.Mock;
    pollDeviceToken: jest.Mock;
  };

  beforeAll(async () => {
    cliDeviceAuthService = {
      startDeviceAuthorization: jest.fn(),
      getAuthorization: jest.fn(),
      decideAuthorization: jest.fn(),
      pollDeviceToken: jest.fn(),
    };
    const publicRouteGuard = {
      canActivate: () => true,
    };
    const moduleFixture = await Test.createTestingModule({
      controllers: [CliAuthController],
      providers: [
        { provide: CliDeviceAuthService, useValue: cliDeviceAuthService },
        { provide: APP_GUARD, useValue: publicRouteGuard },
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

  it('승인된 폴링 요청에 API 키 발급 정보를 반환한다', async () => {
    // Given
    const token = {
      apiKey: 'mhk_1234567890123456789012_1234567890123456789012345678901234567890123',
      keyId: '41',
      expiresAt: '2027-10-07T00:00:00.000Z',
      scopes: ['relay:read', 'relay:write'],
    };
    cliDeviceAuthService.pollDeviceToken.mockResolvedValue(token);

    // When
    const response = await request(app.getHttpServer())
      .post('/api/auth/cli/device/token')
      .send({ deviceCode: 'device-secret' })
      .expect(200);

    // Then
    expect(response.body).toEqual({ result: 'success', data: token });
    expect(cliDeviceAuthService.pollDeviceToken).toHaveBeenCalledWith(
      'device-secret',
      expect.any(String),
    );
  });

  it('승인 전 폴링은 CLI가 해석할 수 있는 authorization_pending 응답을 유지한다', async () => {
    // Given
    cliDeviceAuthService.pollDeviceToken.mockRejectedValue(
      new BadRequestException('authorization_pending'),
    );

    // When
    const response = await request(app.getHttpServer())
      .post('/api/auth/cli/device/token')
      .send({ deviceCode: 'device-secret' })
      .expect(400);

    // Then
    expect(response.body).toEqual({ result: 'fail', data: 'authorization_pending' });
  });
});
