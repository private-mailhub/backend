import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { TokenService } from './jwt/token.service';
import { CacheService } from '../cache/cache.service';
import { UsersService } from '../users/users.service';
import { CustomEnvService } from '../config/custom-env.service';
import { ProtectionUtil } from 'src/common/utils/protection.util';
import { OAuthProvider } from 'src/common/enums/oauth-provider.enum';
import { AuthResponseDto } from './dto/auth-response.dto';
import { UserActivityLogService } from '../logs/user-activity-log.service';
import { UserActivityType } from '../common/enums/activity-type.enum';

interface AppleJWK {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
}

interface OAuthCodeExchangeResult {
  oauthId: string;
  email: string | null;
  encryptedToken?: string;
}

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    private readonly tokenService: TokenService,
    private readonly cacheService: CacheService,
    private readonly usersService: UsersService,
    private readonly customEnvService: CustomEnvService,
    private readonly protectionUtil: ProtectionUtil,
    private readonly userActivityLogService: UserActivityLogService,
  ) {}

  getGithubAuthUrl(redirectUri: string): { url: string } {
    const clientId = this.customEnvService.get<string>('GITHUB_CLIENT_ID');
    const state = JSON.stringify({ provider: 'github' });
    const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user:email&state=${encodeURIComponent(state)}`;
    return { url };
  }

  getGoogleAuthUrl(redirectUri: string): { url: string } {
    const clientId = this.customEnvService.get<string>('GOOGLE_CLIENT_ID');
    const state = JSON.stringify({ provider: 'google' });
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email&state=${encodeURIComponent(state)}&access_type=offline&prompt=consent`;
    return { url };
  }

  async linkWithGithub(userId: bigint, code: string, redirectUri: string): Promise<void> {
    const { oauthId, encryptedToken } = await this.exchangeGithubCode(code, redirectUri);
    await this.usersService.linkOAuth(userId, OAuthProvider.GITHUB, oauthId, encryptedToken);
  }

  async linkWithGoogle(userId: bigint, code: string, redirectUri: string): Promise<void> {
    const { oauthId, encryptedToken } = await this.exchangeGoogleCode(code, redirectUri);
    await this.usersService.linkOAuth(userId, OAuthProvider.GOOGLE, oauthId, encryptedToken);
  }

  async loginWithGithub(
    code: string,
    redirectUri: string,
    ip: string,
    userAgent: string,
  ): Promise<AuthResponseDto> {
    const { oauthId, email, encryptedToken } = await this.exchangeGithubCode(code, redirectUri);
    if (!email) {
      throw new UnauthorizedException('No verified primary email found on GitHub account');
    }
    return this.processOAuthUser(
      email,
      OAuthProvider.GITHUB,
      oauthId,
      ip,
      userAgent,
      encryptedToken,
    );
  }

  async loginWithGoogle(
    code: string,
    redirectUri: string,
    ip: string,
    userAgent: string,
  ): Promise<AuthResponseDto> {
    const { oauthId, email, encryptedToken } = await this.exchangeGoogleCode(code, redirectUri);
    if (!email) {
      throw new UnauthorizedException('Failed to extract user info from Google token');
    }
    return this.processOAuthUser(
      email,
      OAuthProvider.GOOGLE,
      oauthId,
      ip,
      userAgent,
      encryptedToken,
    );
  }

  async loginWithApple(idToken: string, ip: string, userAgent: string): Promise<AuthResponseDto> {
    // Verify Apple id_token using JWKS
    const payload = await this.verifyAppleIdToken(idToken);

    if (!payload || !payload.email) {
      throw new UnauthorizedException('Failed to extract user info from Apple token');
    }

    const email = payload.email as string;
    const oauthId = payload.sub as string;

    return this.processOAuthUser(email, OAuthProvider.APPLE, oauthId, ip, userAgent);
  }

  private async processOAuthUser(
    email: string,
    provider: OAuthProvider,
    oauthId: string,
    ip: string,
    userAgent: string,
    encryptedToken?: string,
  ): Promise<AuthResponseDto> {
    // 1. Find user by OAuth ID
    let user = await this.usersService.findByOAuthId(provider, oauthId);
    let isNewUser = false;

    if (user) {
      // Update stored token on re-login
      if (encryptedToken) {
        await this.usersService.linkOAuth(user.id, provider, oauthId, encryptedToken, {
          recordActivity: false,
        });
      }
    } else {
      // 2. Find user by email hash
      const emailHash = this.protectionUtil.hash(email);
      user = await this.usersService.findByUsernameHash(emailHash);

      if (user) {
        // Link OAuth to existing user
        await this.usersService.linkOAuth(user.id, provider, oauthId, encryptedToken);
      } else {
        // 3. Create new user
        const encryptedEmail = this.protectionUtil.encrypt(email);
        user = await this.usersService.createOAuthUser(
          encryptedEmail,
          provider,
          oauthId,
          encryptedToken,
        );
        isNewUser = true;
      }
    }

    // Update last login
    await this.usersService.updateUser(user.usernameHash, {
      lastLoginedAt: new Date(),
    });

    if (isNewUser) {
      await this.userActivityLogService.record(user.id, UserActivityType.SIGNUP, provider);
    }
    await this.userActivityLogService.record(user.id, UserActivityType.LOGIN, provider);

    // Generate tokens
    const { accessToken, refreshToken } = this.tokenService.generateTokens(user.id, user.username);

    // Store session with fingerprint
    const fingerprint = this.protectionUtil.hash(`${ip}:${userAgent}`);
    await this.cacheService.setSession(refreshToken, fingerprint);

    return { accessToken, refreshToken };
  }

  async unlinkOAuth(userId: bigint, provider: OAuthProvider): Promise<void> {
    // 1. Retrieve stored encrypted token
    const encryptedToken = await this.usersService.getOAuthToken(userId, provider);

    // 2. Revoke token at provider (best-effort)
    if (encryptedToken) {
      const token = this.protectionUtil.decrypt(encryptedToken);
      this.revokeOAuthToken(provider, token)
        .then(() => {
          this.logger.log(`Success to revoke ${provider}`);
        })
        .catch((err) => {
          this.logger.warn(`Failed to revoke ${provider} token for user ${userId}: ${err.message}`);
        });
    }

    // 3. Clear OAuth ID and token from DB
    await this.usersService.unlinkOAuth(userId, provider);
  }

  private async exchangeGithubCode(
    code: string,
    redirectUri: string,
  ): Promise<OAuthCodeExchangeResult> {
    const clientId = this.customEnvService.get<string>('GITHUB_CLIENT_ID');
    const clientSecret = this.customEnvService.get<string>('GITHUB_CLIENT_SECRET');

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      this.logger.error(tokenData, 'GitHub OAuth token exchange failed');
      throw new UnauthorizedException('GitHub OAuth authentication failed');
    }

    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
      },
    });

    if (!userResponse.ok) {
      throw new UnauthorizedException('Failed to fetch GitHub user info');
    }

    const githubUser = await userResponse.json();
    const oauthId = githubUser.id.toString();

    const emailResponse = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
      },
    });

    let email: string | null = null;
    if (emailResponse.ok) {
      const emails = await emailResponse.json();
      const primaryEmail = emails.find(
        (e: { primary: boolean; verified: boolean; email: string }) => e.primary && e.verified,
      );
      email = primaryEmail?.email || null;
    }

    return {
      oauthId,
      email,
      encryptedToken: this.protectionUtil.encrypt(tokenData.access_token),
    };
  }

  private async exchangeGoogleCode(
    code: string,
    redirectUri: string,
  ): Promise<OAuthCodeExchangeResult> {
    const clientId = this.customEnvService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.customEnvService.get<string>('GOOGLE_CLIENT_SECRET');

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      this.logger.error(tokenData, 'Google OAuth token exchange failed');
      throw new UnauthorizedException('Google OAuth authentication failed');
    }

    const idTokenPayload = this.decodeJwtPayload(tokenData.id_token);
    if (!idTokenPayload) {
      throw new UnauthorizedException('Failed to extract user info from Google token');
    }

    const email = (idTokenPayload.email as string | undefined) ?? null;
    const oauthId = idTokenPayload.sub as string;

    return {
      oauthId,
      email,
      encryptedToken: tokenData.refresh_token
        ? this.protectionUtil.encrypt(tokenData.refresh_token)
        : undefined,
    };
  }

  private async revokeOAuthToken(provider: OAuthProvider, token: string): Promise<void> {
    if (provider === OAuthProvider.GITHUB) {
      const clientId = this.customEnvService.get<string>('GITHUB_CLIENT_ID');
      const clientSecret = this.customEnvService.get<string>('GITHUB_CLIENT_SECRET');
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const response = await fetch(`https://api.github.com/applications/${clientId}/token`, {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: token }),
      });

      if (!response.ok && response.status !== 422) {
        throw new Error(`GitHub token revocation failed with status ${response.status}`);
      }
    } else if (provider === OAuthProvider.GOOGLE) {
      const response = await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!response.ok && response.status !== 400) {
        throw new Error(`Google token revocation failed with status ${response.status}`);
      }
    }
  }

  private decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  private async verifyAppleIdToken(idToken: string): Promise<Record<string, unknown> | null> {
    try {
      // Decode header to get kid
      const headerB64 = idToken.split('.')[0];
      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'));
      const kid = header.kid;

      // Fetch Apple's JWKS
      const jwksResponse = await fetch('https://appleid.apple.com/auth/keys');
      const jwks = await jwksResponse.json();
      const key = jwks.keys.find((k: AppleJWK) => k.kid === kid);

      if (!key) {
        throw new Error('Apple public key not found');
      }

      // Convert JWK to PEM for verification
      const publicKey = crypto.createPublicKey({
        key: key,
        format: 'jwk',
      });

      // Verify the JWT signature
      const [headerPart, payloadPart, signaturePart] = idToken.split('.');
      const data = `${headerPart}.${payloadPart}`;
      const signature = Buffer.from(signaturePart, 'base64url');

      const isValid = crypto.verify('RSA-SHA256', Buffer.from(data), publicKey, signature);

      if (!isValid) {
        throw new Error('Invalid Apple id_token signature');
      }

      // Verify claims
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf-8'));

      const appleClientId = this.customEnvService.get<string>('APPLE_CLIENT_ID');

      if (payload.iss !== 'https://appleid.apple.com') {
        throw new Error('Invalid issuer');
      }

      if (payload.aud !== appleClientId) {
        throw new Error('Invalid audience');
      }

      if (payload.exp * 1000 < Date.now()) {
        throw new Error('Token expired');
      }

      return payload;
    } catch (error) {
      this.logger.error(error, 'Apple id_token verification failed');
      throw new UnauthorizedException('Apple OAuth authentication failed');
    }
  }
}
