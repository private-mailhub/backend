import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RelayEmailsController } from './relay-emails.controller';
import { RelayEmailsService } from './relay-emails.service';
import { RelayEmail } from './entities/relay-email.entity';
import { ReplyMasking } from './entities/reply-masking.entity';
import { CacheModule } from '../cache/cache.module';
import { UsersModule } from '../users/users.module';
import { AwsModule } from '../aws/aws.module';
import { QueuePollerService } from './queue-poller.service';
import { ProtectionUtil } from '../common/utils/protection.util';
import { ConfigModule } from 'src/config/config.module';
import { MailModule } from 'src/mail/mail.module';
import { ReplyEmailsService } from './reply-emails.service';
import { LogsModule } from '../logs/logs.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([RelayEmail, ReplyMasking]),
    CacheModule,
    UsersModule,
    AwsModule,
    MailModule,
    ConfigModule,
    LogsModule,
  ],
  controllers: [RelayEmailsController],
  providers: [RelayEmailsService, ReplyEmailsService, QueuePollerService, ProtectionUtil],
  exports: [RelayEmailsService, ReplyEmailsService],
})
export class RelayEmailsModule {}
