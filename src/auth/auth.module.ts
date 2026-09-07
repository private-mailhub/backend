import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OAuthService } from './oauth.service';
import { TokenService } from './jwt/token.service';
import { CacheModule } from '../cache/cache.module';
import { UsersModule } from '../users/users.module';
import { AwsModule } from '../aws/aws.module';
import { MailModule } from 'src/mail/mail.module';
import { LogsModule } from '../logs/logs.module';
import { CustomEnvService } from '../config/custom-env.service';
import { ProtectionUtil } from 'src/common/utils/protection.util';
import { ACCESS_TOKEN_TTL } from 'src/common/utils/policy';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: (customEnvService: CustomEnvService) => {
        const secret = customEnvService.get<string>('JWT_SECRET');

        return {
          secret,
          signOptions: {
            expiresIn: `${ACCESS_TOKEN_TTL}ms`,
          },
        };
      },
      inject: [CustomEnvService],
    }),
    CacheModule,
    UsersModule,
    AwsModule,
    MailModule,
    LogsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, OAuthService, TokenService, ProtectionUtil],
  exports: [AuthService, OAuthService, TokenService],
})
export class AuthModule {}
