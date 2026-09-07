import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { OAuthService } from '../src/auth/oauth.service';
import { applyHttpConfig } from '../src/bootstrap/apply-http-config';

describe('POST /api/auth/refresh', () => {
  let app: INestApplication<App>;
  let authService: { refreshTokens: jest.Mock };
  const previousCorsOrigins = process.env.CORS_ORIGINS;

  beforeAll(async () => {
    process.env.CORS_ORIGINS = 'http://allowed.example';
    authService = { refreshTokens: jest.fn() };

    const moduleFixture = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: OAuthService, useValue: {} },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    applyHttpConfig(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (previousCorsOrigins === undefined) {
      delete process.env.CORS_ORIGINS;
    } else {
      process.env.CORS_ORIGINS = previousCorsOrigins;
    }
  });

  beforeEach(() => {
    authService.refreshTokens.mockReset();
  });

  it('refreshes tokens and rotates the HttpOnly cookie with a valid cookie', async () => {
    authService.refreshTokens.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'rotated-refresh-token',
    });

    const response = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', 'refreshToken=old-refresh-token')
      .set('Origin', 'http://allowed.example')
      .expect(201);

    expect(response.body).toEqual({
      result: 'success',
      data: { accessToken: 'new-access-token' },
    });
    expect(authService.refreshTokens).toHaveBeenCalledWith(
      'old-refresh-token',
      expect.any(String),
      expect.any(String),
    );
    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^refreshToken=rotated-refresh-token; Max-Age=\d+; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=Strict$/,
        ),
      ]),
    );
    expect(response.headers['access-control-allow-origin']).toBe('http://allowed.example');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('exposes CORS headers only for preflight requests from allowed origins', async () => {
    const allowedResponse = await request(app.getHttpServer())
      .options('/api/auth/refresh')
      .set('Origin', 'http://allowed.example')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    const disallowedResponse = await request(app.getHttpServer())
      .options('/api/auth/refresh')
      .set('Origin', 'http://other.example')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);

    expect(allowedResponse.headers['access-control-allow-origin']).toBe('http://allowed.example');
    expect(allowedResponse.headers['access-control-allow-credentials']).toBe('true');
    expect(disallowedResponse.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns a failure without rotating the cookie when refresh is rejected', async () => {
    authService.refreshTokens.mockRejectedValue(new UnauthorizedException('Invalid refresh token'));

    const response = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', 'refreshToken=invalid-refresh-token')
      .expect(401);

    expect(response.body).toEqual({ result: 'fail', data: 'Invalid refresh token' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('returns 401 without calling the service when the cookie is missing', async () => {
    const response = await request(app.getHttpServer()).post('/api/auth/refresh').expect(401);

    expect(response.body).toEqual({
      result: 'fail',
      data: 'Refresh token not found',
    });
    expect(authService.refreshTokens).not.toHaveBeenCalled();
  });
});
