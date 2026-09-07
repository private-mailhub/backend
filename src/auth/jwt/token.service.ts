import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload } from './jwt-payload.interface';
import { CustomEnvService } from '../../config/custom-env.service';
import { TokenPayloadDto } from '../dto/token-response.dto';
import { ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from 'src/common/utils/policy';

@Injectable()
export class TokenService {
  constructor(
    private jwtService: JwtService,
    private customEnvService: CustomEnvService,
  ) {}

  generateAccessToken(userId: bigint, username: string): string {
    const payload: JwtPayload = {
      sub: userId.toString(),
      username,
    };

    return this.jwtService.sign(payload, {
      secret: this.customEnvService.get<string>('JWT_SECRET'),
      expiresIn: `${ACCESS_TOKEN_TTL}ms`,
    });
  }

  generateRefreshToken(userId: bigint, username: string): string {
    const payload: JwtPayload = {
      sub: userId.toString(),
      username,
    };

    return this.jwtService.sign(payload, {
      secret: this.customEnvService.get<string>('JWT_SECRET'),
      expiresIn: `${REFRESH_TOKEN_TTL}ms`,
    });
  }

  generateTokens(userId: bigint, username: string) {
    return {
      accessToken: this.generateAccessToken(userId, username),
      refreshToken: this.generateRefreshToken(userId, username),
    };
  }

  parsePayloadFromToken(token: string): TokenPayloadDto {
    const payload = this.validateToken(token);
    return {
      userId: BigInt(payload.sub),
      username: payload.username,
    };
  }

  getUsernameFromToken(token: string): string {
    const payload = this.validateToken(token);
    return payload.username;
  }

  private validateToken(token: string): JwtPayload {
    const secret = this.customEnvService.get<string>('JWT_SECRET');
    return this.jwtService.verify(token, { secret });
  }

  // Decode token without validation (for expired tokens)
  decodeToken(token: string): TokenPayloadDto | null {
    const decoded = this.jwtService.decode(token);
    if (!decoded) {
      return null;
    }
    return {
      userId: BigInt(decoded.sub),
      username: decoded.username,
    };
  }
}
