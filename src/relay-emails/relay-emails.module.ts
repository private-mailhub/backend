import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RelayEmailsController } from './relay-emails.controller';
import { RelayEmailsService } from './relay-emails.service';
import { RelayEmail } from './entities/relay-email.entity';
import { CacheModule } from '../cache/cache.module';
import { UsersModule } from '../users/users.module';
import { AwsModule } from '../aws/aws.module';
import { QueuePollerService } from './queue-poller.service';
import { ProtectionUtil } from '../common/utils/protection.util';
import { MailRecordModule } from './mail-record.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([RelayEmail]),
    CacheModule,
    UsersModule,
    AwsModule,
    MailRecordModule,
  ],
  controllers: [RelayEmailsController],
  providers: [RelayEmailsService, QueuePollerService, ProtectionUtil],
  exports: [RelayEmailsService, MailRecordModule],
})
export class RelayEmailsModule {}
