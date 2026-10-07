import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_KEY_SCOPE_KEY } from '../../../src/common/decorators/api-key-access.decorator';
import { AuthGuard } from '../../../src/common/guards/auth.guard';
import { TokenService } from '../../../src/auth/jwt/token.service';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let reflector: jest.Mocked<Reflector>;
  let tokenService: jest.Mocked<TokenService>;
  let apiKeyService: { validate: jest.Mock };

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn((metadataKey: string) =>
        metadataKey === API_KEY_SCOPE_KEY ? 'relay:read' : false,
      ),
    } as unknown as jest.Mocked<Reflector>;
    tokenService = {
      parsePayloadFromToken: jest.fn(),
    } as unknown as jest.Mocked<TokenService>;
    apiKeyService = {
      validate: jest.fn(),
    };
    const GuardConstructor = AuthGuard as unknown as new (...args: unknown[]) => AuthGuard;
    guard = new GuardConstructor(reflector, tokenService, apiKeyService);
  });

  function contextFor(request: Record<string, unknown>): ExecutionContext {
    return {
      getHandler: () => jest.fn(),
      getClass: () => AuthGuard,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  describe('API-key authentication', () => {
    it('read scope가 있으면 relay 목록 경로에서 사용자 정보를 설정한다', async () => {
      // Given
      const request = {
        method: 'GET',
        originalUrl: '/api/relay-emails',
        url: '/api/relay-emails',
        headers: {
          authorization:
            'Bearer mhk_1234567890123456789012_1234567890123456789012345678901234567890123',
        },
      };
      apiKeyService.validate.mockResolvedValue({
        userId: 17n,
        username: 'owner@example.com',
        keyId: 41,
        scopes: ['relay:read'],
      });

      // When
      const result = await Promise.resolve().then(() => guard.canActivate(contextFor(request)));

      // Then
      expect(result).toBe(true);
      expect(apiKeyService.validate).toHaveBeenCalledWith(
        'mhk_1234567890123456789012_1234567890123456789012345678901234567890123',
      );
      expect(request).toMatchObject({
        user: { userId: 17n, username: 'owner@example.com' },
        apiKey: { keyId: 41, scopes: ['relay:read'] },
      });
    });

    it('write scope가 없는 키는 relay 변경을 거부한다', async () => {
      // Given
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce('relay:write');
      const request = {
        method: 'PATCH',
        originalUrl: '/api/relay-emails/9/active',
        url: '/api/relay-emails/9/active',
        headers: {
          authorization:
            'Bearer mhk_1234567890123456789012_1234567890123456789012345678901234567890123',
        },
      };
      apiKeyService.validate.mockResolvedValue({
        userId: 17n,
        username: 'owner@example.com',
        keyId: 41,
        scopes: ['relay:read'],
      });

      // When / Then
      await expect(
        Promise.resolve().then(() => guard.canActivate(contextFor(request))),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('API key는 인증되지 않은 계정 경로에 기본 허용되지 않는다', async () => {
      // Given
      const request = {
        method: 'DELETE',
        originalUrl: '/api/users/account',
        url: '/api/users/account',
        headers: {
          authorization:
            'Bearer mhk_1234567890123456789012_1234567890123456789012345678901234567890123',
        },
      };
      apiKeyService.validate.mockResolvedValue({
        userId: 17n,
        username: 'owner@example.com',
        keyId: 41,
        scopes: ['relay:read', 'relay:write', 'keys:read', 'keys:revoke'],
      });

      // When / Then
      await expect(
        Promise.resolve().then(() => guard.canActivate(contextFor(request))),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('API key로 기기 승인 엔드포인트에 접근할 수 없다', async () => {
      // Given
      const request = {
        method: 'POST',
        originalUrl: '/api/auth/cli/device/decision',
        url: '/api/auth/cli/device/decision',
        headers: {
          authorization:
            'Bearer mhk_1234567890123456789012_1234567890123456789012345678901234567890123',
        },
      };
      apiKeyService.validate.mockResolvedValue({
        userId: 17n,
        username: 'owner@example.com',
        keyId: 41,
        scopes: ['relay:read', 'relay:write', 'keys:read', 'keys:revoke'],
      });

      // When / Then
      await expect(
        Promise.resolve().then(() => guard.canActivate(contextFor(request))),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('폐기된 키는 401로 거부한다', async () => {
      // Given
      const request = {
        method: 'GET',
        originalUrl: '/api/relay-emails',
        url: '/api/relay-emails',
        headers: {
          authorization:
            'Bearer mhk_1234567890123456789012_1234567890123456789012345678901234567890123',
        },
      };
      apiKeyService.validate.mockRejectedValue(new UnauthorizedException('API_KEY_REVOKED'));

      // When / Then
      await expect(
        Promise.resolve().then(() => guard.canActivate(contextFor(request))),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
