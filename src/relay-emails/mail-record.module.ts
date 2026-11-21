import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProtectionUtil } from '../common/utils/protection.util';
import { EmailForwardingLog } from '../logs/entities/email-forwarding-log.entity';
import { EmailForwardingLogService } from '../logs/email-forwarding-log.service';
import { RelayEmail } from './entities/relay-email.entity';
import { ReplyMasking } from './entities/reply-masking.entity';
import { MailDelivery } from './entities/mail-delivery.entity';
import { MailObjectReader } from './mail-object';
import { MailDeliveryLedger } from './mail-delivery-ledger';
import { MailDeliveryTransport } from './mail-delivery-transport';
import { MailRecordProcessor } from './mail-record-processor';
import { ReplyEmailsService } from './reply-emails.service';

// The host supplies CustomEnvService and one default TypeORM connection. Importing
// this module alone must never start an HTTP server, scheduler or SQS receiver.
@Module({
  imports: [TypeOrmModule.forFeature([RelayEmail, ReplyMasking, MailDelivery, EmailForwardingLog])],
  providers: [
    ProtectionUtil,
    MailObjectReader,
    MailDeliveryLedger,
    MailDeliveryTransport,
    ReplyEmailsService,
    EmailForwardingLogService,
    MailRecordProcessor,
  ],
  exports: [MailRecordProcessor, ReplyEmailsService],
})
export class MailRecordModule {
  // Only the isolated worker host needs an alternative transport (a capture sink).
  static withTransport(transport: Type<Pick<MailDeliveryTransport, 'prepare'>>): DynamicModule {
    return {
      module: MailRecordModule,
      providers: [{ provide: MailDeliveryTransport, useClass: transport }],
    };
  }
}
