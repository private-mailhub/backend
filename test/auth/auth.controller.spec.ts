import { AuthController } from '../../src/auth/auth.controller';
import { OAuthProvider } from '../../src/common/enums/oauth-provider.enum';
import { AuthService } from '../../src/auth/auth.service';
import { OAuthService } from '../../src/auth/oauth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<AuthService>;
  let oauthService: jest.Mocked<OAuthService>;

  beforeEach(() => {
    authService = {
      sendVerificationCode: jest.fn(),
      verifyCodeAndLogin: jest.fn(),
      refreshTokens: jest.fn(),
      logout: jest.fn(),
    } as unknown as jest.Mocked<AuthService>;
    oauthService = {
      getGithubAuthUrl: jest.fn(),
      getGoogleAuthUrl: jest.fn(),
      loginWithGithub: jest.fn(),
      loginWithGoogle: jest.fn(),
      loginWithApple: jest.fn(),
      linkWithGithub: jest.fn(),
      linkWithGoogle: jest.fn(),
      unlinkOAuth: jest.fn(),
    } as unknown as jest.Mocked<OAuthService>;

    controller = new AuthController(authService, oauthService);
  });

  it('routes GitHub link callbacks through the current user', async () => {
    await expect(
      controller.linkGithubOAuth(
        { userId: 7n, username: 'user@example.com' },
        { code: 'code', redirectUri: 'https://app.test/login/oauth/github/callback' },
      ),
    ).resolves.toEqual({ message: 'GitHub OAuth linked successfully' });

    expect(oauthService.linkWithGithub.mock.calls[0]).toEqual([
      7n,
      'code',
      'https://app.test/login/oauth/github/callback',
    ]);
  });

  it('routes Google link callbacks through the current user', async () => {
    await expect(
      controller.linkGoogleOAuth(
        { userId: 8n, username: 'user@example.com' },
        { code: 'code', redirectUri: 'https://app.test/login/oauth/google/callback' },
      ),
    ).resolves.toEqual({ message: 'Google OAuth linked successfully' });

    expect(oauthService.linkWithGoogle.mock.calls[0]).toEqual([
      8n,
      'code',
      'https://app.test/login/oauth/google/callback',
    ]);
  });

  it('keeps unlink behavior intact', async () => {
    await expect(
      controller.unlinkOAuth(
        { userId: 9n, username: 'user@example.com' },
        { provider: OAuthProvider.GITHUB },
      ),
    ).resolves.toEqual({ message: 'github OAuth unlinked successfully' });

    expect(oauthService.unlinkOAuth.mock.calls[0]).toEqual([9n, OAuthProvider.GITHUB]);
  });
});
