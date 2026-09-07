import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module';
import { CacheModule } from './cache/cache.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RelayEmailsModule } from './relay-emails/relay-emails.module';
import { AwsModule } from './aws/aws.module';
import { AdminModule } from './admin/admin.module';
import { LogsModule } from './logs/logs.module';
import { User } from './users/entities/user.entity';
import { OAuthAccount } from './users/entities/oauth-account.entity';
import { RelayEmail } from './relay-emails/entities/relay-email.entity';
import { ReplyMasking } from './relay-emails/entities/reply-masking.entity';
import { UserActivityLog } from './logs/entities/user-activity-log.entity';
import { EmailForwardingLog } from './logs/entities/email-forwarding-log.entity';
import { AuthGuard } from './common/guards/auth.guard';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DATABASE_HOST,
      port: parseInt(process.env.DATABASE_PORT || '3306'),
      database: process.env.DATABASE_NAME,
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      entities: [User, OAuthAccount, RelayEmail, ReplyMasking, UserActivityLog, EmailForwardingLog],
      synchronize: false,
      logging: process.env.NODE_ENV === 'production',
    }),
    ConfigModule,
    CacheModule,
    AuthModule,
    UsersModule,
    RelayEmailsModule,
    AwsModule,
    AdminModule,
    LogsModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule {}
