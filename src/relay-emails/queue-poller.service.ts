import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SqsService } from '../aws/sqs/sqs.service';
import { MailRecordProcessor } from './mail-record-processor';

@Injectable()
export class QueuePollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueuePollerService.name);
  private enabled = false;
  private inFlight?: Promise<void>;
  constructor(
    private readonly sqs: SqsService,
    private readonly processor: MailRecordProcessor,
  ) {}

  onModuleInit(): void {
    this.enabled = process.env.WORKER_MODE === 'true';
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async pollSQS(): Promise<void> {
    if (!this.enabled || this.inFlight) return;
    this.inFlight = this.receiveBatch();
    try {
      await this.inFlight;
    } catch {
      this.logger.error('SQS receive failed');
    } finally {
      this.inFlight = undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.enabled = false;
    // Includes a pending long poll, every record in a started batch and its deletes.
    await this.inFlight?.catch(() => undefined);
    this.logger.log('Queue polling drained');
  }

  private async receiveBatch(): Promise<void> {
    const messages = await this.sqs.receiveMessages(10);
    if (!this.enabled) return; // Returned during drain: untouched, becomes visible again.
    const results = await Promise.allSettled(
      messages.map(async (message) => {
        if (!message.Body || !message.ReceiptHandle) throw new Error('Missing SQS envelope field');
        await this.processor.processSqsBody(message.Body);
        await this.sqs.deleteMessage(message.ReceiptHandle);
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed)
      this.logger.warn(`${failed} SQS message(s) not acknowledged; retry/redrive required`);
  }
}
