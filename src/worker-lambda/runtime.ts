import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CustomEnvService } from '../config/custom-env.service';
import { MailRecordModule } from '../relay-emails/mail-record.module';
import { MailRecordProcessor } from '../relay-emails/mail-record-processor';
import { MailDelivery } from '../relay-emails/entities/mail-delivery.entity';
import { RelayEmail } from '../relay-emails/entities/relay-email.entity';
import { ReplyMasking } from '../relay-emails/entities/reply-masking.entity';
import { EmailForwardingLog } from '../logs/entities/email-forwarding-log.entity';
import { User } from '../users/entities/user.entity';
import { IsolatedCaptureTransport } from './capture';
import { loadWorkerConfig } from './config';
import type { WorkerRuntime } from './batch';

@Global()
@Module({})
class WorkerConfigModule {}
@Module({})
class WorkerRoot {}

export async function bootstrapWorker(): Promise<WorkerRuntime> {
  const { workerEnv, db, stage } = await loadWorkerConfig();
  const app = await NestFactory.createApplicationContext(
    {
      module: WorkerRoot,
      imports: [
        {
          module: WorkerConfigModule,
          providers: [{ provide: CustomEnvService, useValue: workerEnv }],
          exports: [CustomEnvService],
        },
        TypeOrmModule.forRoot({
          ...db,
          entities: [MailDelivery, RelayEmail, ReplyMasking, EmailForwardingLog, User],
        }),
        stage === 'isolated'
          ? MailRecordModule.withTransport(IsolatedCaptureTransport)
          : MailRecordModule,
      ],
    },
    { logger: false, abortOnError: false },
  );
  const processor = app.get(MailRecordProcessor);
  const data = app.get(DataSource);
  return {
    processSqsBody: (body) => processor.processSqsBody(body),
    checkReadiness: async () => {
      // Validate the deployed schema without reading a mailbox or changing any rows.
      await data.query(
        'SELECT record_id, state, owner, lease_until, provider_id, skip_reason FROM mail_deliveries LIMIT 0',
      );
    },
  };
}
