import { ConflictException } from '@nestjs/common';
import { OAuthService } from '../../src/auth/oauth.service';
import { OAuthProvider } from '../../src/common/enums/oauth-provider.enum';
import { UserActivityLogService } from '../../src/logs/user-activity-log.service';
import { CacheService } from '../../src/cache/cache.service';
import { TokenService } from '../../src/auth/jwt/token.service';
import { UsersService } from '../../src/users/users.service';
import { CustomEnvService } from '../../src/config/custom-env.service';
import { ProtectionUtil } from '../../src/common/utils/protection.util';

function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('OAuthService', () => {
  let service: OAuthService;
  let tokenService: jest.Mocked<TokenService>;
  let cacheService: jest.Mocked<CacheService>;
  let usersService: jest.Mocked<UsersService>;
  let customEnvService: jest.Mocked<CustomEnvService>;
  let protectionUtil: jest.Mocked<ProtectionUtil>;
  let userActivityLogService: jest.Mocked<UserActivityLogService>;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    tokenService = {
      generateTokens: jest.fn(),
    } as unknown as jest.Mocked<TokenService>;
    cacheService = {
      setSession: jest.fn(),
    } as unknown as jest.Mocked<CacheService>;
    usersService = {
      findByOAuthId: jest.fn(),
      findByUsernameHash: jest.fn(),
      linkOAuth: jest.fn(),
      createOAuthUser: jest.fn(),
      updateUser: jest.fn(),
      getOAuthToken: jest.fn(),
      unlinkOAuth: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;
    customEnvService = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'GITHUB_CLIENT_ID':
            return 'github-client-id';
          case 'GITHUB_CLIENT_SECRET':
            return 'github-client-secret';
          case 'GOOGLE_CLIENT_ID':
            return 'google-client-id';
          case 'GOOGLE_CLIENT_SECRET':
            return 'google-client-secret';
          case 'APPLE_CLIENT_ID':
            return 'apple-client-id';
          default:
            return '';
        }
      }),
    } as unknown as jest.Mocked<CustomEnvService>;
    protectionUtil = {
      encrypt: jest.fn((value: string) => `enc:${value}`),
      decrypt: jest.fn((value: string) => value.replace(/^enc:/, '')),
      hash: jest.fn((value: string) => `hash:${value}`),
    } as unknown as jest.Mocked<ProtectionUtil>;
    userActivityLogService = {
      record: jest.fn(),
    } as unknown as jest.Mocked<UserActivityLogService>;
    service = new OAuthService(
      tokenService,
      cacheService,
      usersService,
      customEnvService,
      protectionUtil,
      userActivityLogService,
    );
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('links a GitHub account to the current user', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'github-access-token' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 987654 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([{ primary: true, verified: true, email: 'person@example.com' }]),
      } as Response);

    await service.linkWithGithub(1n, 'code', 'https://app.test/login/oauth/github/callback');

    expect(usersService.linkOAuth.mock.calls[0]).toEqual([
      1n,
      OAuthProvider.GITHUB,
      '987654',
      'enc:github-access-token',
    ]);
  });

  it('links a Google account to the current user', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id_token: buildJwt({ sub: 'google-subject', email: 'person@example.com' }),
          refresh_token: 'google-refresh-token',
        }),
    } as Response);

    await service.linkWithGoogle(2n, 'code', 'https://app.test/login/oauth/google/callback');

    expect(usersService.linkOAuth.mock.calls[0]).toEqual([
      2n,
      OAuthProvider.GOOGLE,
      'google-subject',
      'enc:google-refresh-token',
    ]);
  });

  it('surfaces a conflict when the OAuth identity already belongs to another user', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'github-access-token' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 111222 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([{ primary: true, verified: true, email: 'person@example.com' }]),
      } as Response);

    usersService.linkOAuth.mockRejectedValueOnce(
      new ConflictException('OAuth account is already linked to another user'),
    );

    await expect(
      service.linkWithGithub(3n, 'code', 'https://app.test/login/oauth/github/callback'),
    ).rejects.toThrow('OAuth account is already linked to another user');
  });

  it('unlinks an OAuth provider and revokes the stored token best-effort', async () => {
    usersService.getOAuthToken.mockResolvedValueOnce('enc:github-access-token');
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as Response);

    await service.unlinkOAuth(4n, OAuthProvider.GITHUB);

    expect(usersService.getOAuthToken.mock.calls[0]).toEqual([4n, OAuthProvider.GITHUB]);
    expect(usersService.unlinkOAuth.mock.calls[0]).toEqual([4n, OAuthProvider.GITHUB]);
    expect(fetchSpy.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'https://api.github.com/applications/github-client-id/token',
          expect.objectContaining({ method: 'DELETE' }),
        ],
      ]),
    );
  });
});
