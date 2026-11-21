import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { SendMailOptions } from 'nodemailer';
import { Repository } from 'typeorm';
import { CustomEnvService } from '../config/custom-env.service';
import { ProtectionUtil } from '../common/utils/protection.util';
import { EmailForwardingLogService } from '../logs/email-forwarding-log.service';
import { RelayEmail } from './entities/relay-email.entity';
import { ReplyEmailsService } from './reply-emails.service';
import { forwardedBody } from './forwarded-body';
import { MailDeliveryLedger, type SkipReason } from './mail-delivery-ledger';
import { MailDeliveryTransport, type PreparedSend } from './mail-delivery-transport';
import { MailObjectReader, mailObject, s3Records, type MailObject } from './mail-object';

interface Delivery {
  submit: PreparedSend;
  relay: string;
  audit?: { userId: bigint; relayId: bigint; senderHash: string };
}

@Injectable()
export class MailRecordProcessor {
  private readonly logger = new Logger(MailRecordProcessor.name);
  constructor(
    private readonly config: CustomEnvService,
    private readonly ledger: MailDeliveryLedger,
    private readonly objects: MailObjectReader,
    @InjectRepository(RelayEmail) private readonly relays: Repository<RelayEmail>,
    private readonly masks: ReplyEmailsService,
    private readonly protection: ProtectionUtil,
    private readonly transport: MailDeliveryTransport,
    private readonly forwardingLog: EmailForwardingLogService,
  ) {}

  async processSqsBody(body: string): Promise<void> {
    const records = s3Records(body);
    const failures: unknown[] = [];
    for (const raw of records) {
      // Do not abandon later objects when a sibling is malformed, busy or unknown.
      // SQS retries the envelope; committed successes and intentional skips are deduplicated.
      try {
        await this.processObject(mailObject(raw, this.config.get<string>('AWS_S3_EMAIL_BUCKET')));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'S3 notification contains unfinished deliveries');
  }

  private async processObject(item: MailObject): Promise<void> {
    const claim = await this.ledger.claim(item.id);
    if (!claim) return;
    let delivery: Delivery | SkipReason;
    try {
      delivery = await this.prepare(item);
      if (typeof delivery === 'string') {
        await this.ledger.skip(claim, delivery);
        return;
      }
      await this.ledger.beginSend(claim);
    } catch (error) {
      // Commit-ack loss on beginSend is safe too: release only matches 'preparing'.
      await this.ledger.release(claim);
      throw error;
    }

    let providerId: string;
    try {
      providerId = await delivery.submit();
    } catch {
      // If this update also fails the original 'sending' remains non-reclaimable.
      await this.ledger.unknown(claim);
      throw new Error(`Provider result unknown: ${item.id}`);
    }
    // If persistence fails after acceptance, leave 'sending' (or 'sent' if committed).
    // Never undo an ambiguous commit and never submit again to repair bookkeeping.
    await this.ledger.sent(claim, providerId);
    await this.recordMetrics(delivery);
  }

  private async prepare(item: MailObject): Promise<Delivery | SkipReason> {
    const mail = await simpleParser(await this.objects.read(item), { skipImageLinks: true });
    const to = (Array.isArray(mail.to) ? mail.to : [mail.to])
      .flatMap((v) => v?.value ?? [])
      .find((a) => a.address)?.address;
    if (!to) throw new Error('Mail has no recipient');
    const message: SendMailOptions = {
      subject: mail.subject || '(No Subject)',
      attachments: mail.attachments.map((a) => ({
        filename: a.filename || 'unnamed',
        content: a.content,
        contentType: a.contentType,
        contentDisposition: a.contentDisposition === 'inline' ? 'inline' : 'attachment',
        cid: a.cid,
      })),
    };
    if (to.startsWith('reply-')) {
      const mask = await this.masks.findByReplyAddress(to);
      if (!mask) return 'unknown_reply';
      const relay = this.protection.decrypt(mask.receiverAddress);
      const destination = this.protection.decrypt(mask.senderAddress);
      const submit = await this.transport.prepare(item.id, destination, {
        ...message,
        from: { name: '', address: relay },
        replyTo: { name: '', address: relay },
        html: mail.html || undefined,
        text: mail.text,
      });
      return { submit, relay };
    }
    const relay = await this.relays.findOne({ where: { relayEmail: to } });
    if (!relay) return 'unknown_relay';
    if (!relay.isActive) return 'inactive_relay';
    const sender = this.sender(mail);
    if (!sender) throw new Error('Mail has no sender');
    const destination = this.protection.decrypt(relay.primaryEmail);
    const mask = await this.masks.create(sender, to);
    const submit = await this.transport.prepare(item.id, destination, {
      ...message,
      from: { name: `${sender} [via Mailhub]`, address: to },
      replyTo: { name: '', address: mask.replyAddress },
      headers: { 'Resent-From': to },
      html: forwardedBody(
        sender,
        to,
        mail,
        this.config.get<string>('APP_NAME'),
        this.config.get<string>('APP_DOMAIN'),
      ),
    });
    return {
      submit,
      relay: to,
      audit: {
        userId: relay.userId,
        relayId: relay.id,
        senderHash: this.protection.hashEmailAddress(sender),
      },
    };
  }

  private sender(mail: ParsedMail): string | undefined {
    const from = mail.from?.value[0]?.address;
    if (from) return from;
    const path = mail.headers.get('return-path');
    if (typeof path === 'string') return path.match(/<?([^\s<>]+@[^\s<>]+)>?/)?.[1];
    if (path && typeof path === 'object' && 'value' in path && Array.isArray(path.value))
      return path.value[0]?.address;
  }

  private async recordMetrics(delivery: Delivery): Promise<void> {
    try {
      await this.relays
        .createQueryBuilder()
        .update(RelayEmail)
        .set({ forwardCount: () => 'forward_count + 1', lastForwardedAt: new Date() })
        .where('relay_email = :relay', { relay: delivery.relay })
        .execute();
    } catch {
      this.logger.warn('Unable to update forwarding counter after provider acceptance');
    }
    if (delivery.audit) {
      const { userId, relayId, senderHash } = delivery.audit;
      try {
        await this.forwardingLog.record(userId, relayId, senderHash);
      } catch {
        this.logger.warn('Unable to record forwarding audit after provider acceptance');
      }
    }
  }
}
