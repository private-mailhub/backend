import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { TokenService } from './jwt/token.service';
import { CacheService } from '../cache/cache.service';
import { UsersService } from '../users/users.service';
import { SendMailService } from '../mail/send-mail.service';
import { CustomEnvService } from '../config/custom-env.service';
import { LoginDto } from './dto/login.dto';
import { TokenPayloadDto } from './dto/token-response.dto';
import { ProtectionUtil } from 'src/common/utils/protection.util';
import { AuthResponseDto } from './dto/auth-response.dto';
import { UserActivityLogService } from '../logs/user-activity-log.service';
import { UserActivityType } from '../common/enums/activity-type.enum';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly tokenService: TokenService,
    private readonly cacheService: CacheService,
    private readonly usersService: UsersService,
    private readonly sendMailService: SendMailService,
    private readonly customEnvService: CustomEnvService,
    private readonly protectionUtil: ProtectionUtil,
    private readonly userActivityLogService: UserActivityLogService,
  ) {}

  async sendVerificationCode(encryptedUsername: string): Promise<{ isNewUser: boolean }> {
    const username = this.protectionUtil.decrypt(encryptedUsername);
    const usernameHash = this.protectionUtil.hash(username);

    // Check if user exists
    const existingUser = await this.usersService.findByUsernameHash(usernameHash);
    const isNewUser = !existingUser;

    // Generate a 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Store the code in Redis with TTL
    await this.cacheService.setVerificationCode(usernameHash, code);

    // Reset verification attempts
    void this.cacheService.resetVerificationAttempts(usernameHash);

    // Send the code via email with appropriate template
    if (isNewUser) {
      await this.sendMailService.sendVerificationCodeForNewUser(username, code);
    } else {
      await this.sendMailService.sendVerificationCodeForReturningUser(username, code);
    }

    return { isNewUser };
  }

  async verifyCodeAndLogin(dto: LoginDto, ip: string, userAgent: string): Promise<AuthResponseDto> {
    // username is used only for create account
    const { encryptedUsername, code } = dto;
    const usernameHash = this.protectionUtil.hash(this.protectionUtil.decrypt(encryptedUsername));

    // Check verification attempts
    const maxAttempts = this.customEnvService.getWithDefault<number>(
      'VERIFICATION_CODE_MAX_ATTEMPTS',
      3,
    );
    const attempts = await this.cacheService.getVerificationAttempts(usernameHash);

    if (maxAttempts && attempts >= maxAttempts) {
      throw new HttpException(
        'Too many failed attempts. Please request a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Get stored verification code
    const storedCode = await this.cacheService.getVerificationCode(usernameHash);

    if (!storedCode) {
      throw new BadRequestException(
        'Verification code not found or expired. Please request a new code.',
      );
    }

    // Verify the code
    if (storedCode !== code) {
      // Increment failed attempts
      await this.cacheService.incrementVerificationAttempts(usernameHash);
      throw new UnauthorizedException('Invalid verification code');
    }

    // Code is valid - clean up
    await this.cacheService.deleteVerificationCode(usernameHash);
    await this.cacheService.resetVerificationAttempts(usernameHash);

    // Check if user exists, if not create new user
    let user = await this.usersService.findByUsernameHash(usernameHash);

    if (!user) {
      user = await this.usersService.createEmailUser(encryptedUsername);
      // Send welcome email
      await this.sendMailService.sendWelcomeEmail(this.protectionUtil.decrypt(encryptedUsername));
      await this.userActivityLogService.record(user.id, UserActivityType.SIGNUP);
    }
    // update last_logined_at
    await this.usersService.updateUser(usernameHash, {
      lastLoginedAt: new Date(),
    });

    await this.userActivityLogService.record(user.id, UserActivityType.LOGIN);

    // Generate tokens
    const { accessToken, refreshToken } = this.tokenService.generateTokens(user.id, user.username);

    // Store session with fingerprint
    const fingerprint = this.protectionUtil.hash(`${ip}:${userAgent}`);
    await this.cacheService.setSession(refreshToken, fingerprint);

    return { accessToken, refreshToken };
  }

  async refreshTokens(
    refreshToken: string,
    ip: string,
    userAgent: string,
  ): Promise<AuthResponseDto> {
    // Verify refresh token (throws TokenExpiredError if expired)
    let payload: TokenPayloadDto;
    try {
      payload = this.tokenService.parsePayloadFromToken(refreshToken);
    } catch (error) {
      this.logger.debug(`failed to verify refresh token by ${error.message}`);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Check if session exists in Redis
    let storedFingerprint: string;
    try {
      storedFingerprint = await this.cacheService.getSession(refreshToken);
    } catch {
      throw new UnauthorizedException('Session not found');
    }

    // Verify fingerprint
    const currentFingerprint = this.protectionUtil.hash(`${ip}:${userAgent}`);
    if (storedFingerprint !== currentFingerprint) {
      // Possible token theft — delete the session
      await this.cacheService.delSession(refreshToken);
      throw new ForbiddenException('Client fingerprint mismatch');
    }

    // Generate new token pair
    const newTokens = this.tokenService.generateTokens(payload.userId, payload.username);

    // Rotate: delete old session, store new one
    await this.cacheService.delSession(refreshToken);
    const newFingerprint = this.protectionUtil.hash(`${ip}:${userAgent}`);
    await this.cacheService.setSession(newTokens.refreshToken, newFingerprint);

    return {
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
    };
  }

  verifyToken(accessToken: string): boolean {
    try {
      this.parsePayloadFromToken(accessToken);
      return true;
    } catch {
      return false;
    }
  }

  parsePayloadFromToken(accessToken: string): TokenPayloadDto {
    return this.tokenService.parsePayloadFromToken(accessToken);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.cacheService.delSession(refreshToken);

    // Best-effort: resolve the user from the token to record the logout activity.
    // An invalid/expired token simply skips logging and never fails logout.
    try {
      const { userId } = this.tokenService.parsePayloadFromToken(refreshToken);
      await this.userActivityLogService.record(userId, UserActivityType.LOGOUT);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Skipping logout activity log: ${message}`);
    }
  }
}
