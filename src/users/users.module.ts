import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { OAuthAccount } from './entities/oauth-account.entity';
import { ProtectionUtil } from 'src/common/utils/protection.util';
import { CacheModule } from '../cache/cache.module';
import { AwsModule } from '../aws/aws.module';
import { MailModule } from 'src/mail/mail.module';
import { LogsModule } from '../logs/logs.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, OAuthAccount]),
    CacheModule,
    AwsModule,
    MailModule,
    LogsModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, ProtectionUtil],
  exports: [UsersService],
})
export class UsersModule {}
