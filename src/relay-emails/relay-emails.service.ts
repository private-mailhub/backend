import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Message } from '@aws-sdk/client-sqs';
import { Repository } from 'typeorm';
import { ParsedMail, simpleParser } from 'mailparser';
import { CacheService } from '../cache/cache.service';
import { RelayEmail } from './entities/relay-email.entity';
import { S3Service } from 'src/aws/s3/s3.service';
import { S3EventRecord, SqsService } from 'src/aws/sqs/sqs.service';
import { SendMailService } from 'src/mail/send-mail.service';
import { CustomEnvService } from 'src/config/custom-env.service';
import { ProtectionUtil } from 'src/common/utils/protection.util';
import { generateRelayUsername } from 'src/common/utils/relay-email.util';
import { User } from 'src/users/entities/user.entity';
import { isProTier } from 'src/common/utils/permission.util';
import { ReplyEmailsService } from './reply-emails.service';
import { EmailForwardingLogService } from '../logs/email-forwarding-log.service';

@Injectable()
export class RelayEmailsService {
  private readonly logger = new Logger(RelayEmailsService.name);
  private readonly FREE_LIMIT = 20;

  constructor(
    @InjectRepository(RelayEmail)
    private readonly relayEmailRepository: Repository<RelayEmail>,
    private readonly customEnvService: CustomEnvService,
    private readonly replyMaskEmailService: ReplyEmailsService,
    private readonly s3Service: S3Service,
    private readonly sqsService: SqsService,
    private readonly sendMailService: SendMailService,
    private readonly cacheService: CacheService,
    private readonly encryptionUtil: ProtectionUtil,
    private readonly emailForwardingLogService: EmailForwardingLogService,
  ) {}

  async generateRelayEmailAddress(user: User): Promise<RelayEmail> {
    if (!isProTier(user)) {
      const count = await this.countByUser(user.id);
      if (count >= this.FREE_LIMIT) {
        throw new ForbiddenException(
          `FREE tier users can only create up to ${this.FREE_LIMIT}relay emails`,
        );
      }
    }

    // Generate a unique relay address
    let relayEmail: string = '';
    let exists = true;

    while (exists) {
      const username = generateRelayUsername();
      relayEmail = `${username}@${this.customEnvService.get<string>('APP_DOMAIN')}`;

      // Check if this relay address already exists
      const existing = await this.relayEmailRepository.findOne({
        where: { relayEmail },
      });

      exists = !!existing;
    }

    // Create the relay email record
    const relayEmailEntity = this.relayEmailRepository.create({
      userId: user.id,
      primaryEmail: user.username,
      relayEmail,
    });

    const savedRelayEmail = await this.relayEmailRepository.save(relayEmailEntity);

    // Cache the mapping (store encrypted email in cache too)
    await this.cacheService.setRelayMailCache({
      encryptedPrimaryEmail: user.username,
      relayEmail,
    });

    return savedRelayEmail;
  }

  async generateCustomRelayEmailAddress(user: User, customUsername: string): Promise<RelayEmail> {
    // Check permission
    if (!isProTier(user)) {
      throw new ForbiddenException('User can not create custom email address');
    }
    // Build custom relay address
    const customRelayEmail = `${customUsername}@${this.customEnvService.get<string>('APP_DOMAIN')}`;

    // Check if this relay address already exists
    const existing = await this.relayEmailRepository.findOne({
      where: { relayEmail: customRelayEmail },
    });

    if (existing) {
      throw new BadRequestException('Duplicated email address');
    }

    // Create the relay email record
    const relayEmail = this.relayEmailRepository.create({
      userId: user.id,
      primaryEmail: user.username,
      relayEmail: customRelayEmail,
    });

    const savedRelayEmail = await this.relayEmailRepository.save(relayEmail);

    // Cache the mapping (store encrypted email in cache too)
    await this.cacheService.setRelayMailCache({
      encryptedPrimaryEmail: user.username,
      relayEmail: customRelayEmail,
    });

    return savedRelayEmail;
  }

  async findPrimaryEmailByRelayEmail(relayEmail: string): Promise<string | null> {
    // Try cache first
    const cachedEncryptedEmail = await this.cacheService.findPrimaryMailFromCache(relayEmail);

    if (cachedEncryptedEmail) {
      // Decrypt before returning
      return this.encryptionUtil.decrypt(cachedEncryptedEmail);
    }

    // If not in cache, query database
    const relayEmailEntity = await this.relayEmailRepository.findOne({
      where: { relayEmail },
    });

    if (!relayEmailEntity) {
      return null;
    }

    // Cache for future requests (store encrypted)
    await this.cacheService.setRelayMailCache({
      relayEmail,
      encryptedPrimaryEmail: relayEmailEntity.primaryEmail,
    });

    // Decrypt before returning
    return this.encryptionUtil.decrypt(relayEmailEntity.primaryEmail);
  }

  async processIncomingEmails(): Promise<void> {
    const startTime = Date.now();

    try {
      const messages = await this.sqsService.receiveMessages(10);

      if (messages.length === 0) {
        return;
      }

      this.logger.log(`Processing ${messages.length} SQS messages in parallel`);

      // Process all messages in parallel using Promise.allSettled
      const results = await Promise.allSettled(
        messages.map(async (message) => {
          const messageStartTime = Date.now();

          try {
            await this.processMessage(message);

            // Delete message from queue after successful processing
            if (message.ReceiptHandle) {
              await this.sqsService.deleteMessage(message.ReceiptHandle);
            }

            const messageElapsed = Date.now() - messageStartTime;
            this.logger.log(
              `Successfully processed message ${message.MessageId} in ${messageElapsed}ms`,
            );

            return {
              success: true,
              messageId: message.MessageId,
              elapsed: messageElapsed,
            };
          } catch (error) {
            const messageElapsed = Date.now() - messageStartTime;
            this.logger.error(
              `Failed to process message ${message.MessageId} after ${messageElapsed}ms: ${error.message}`,
              error.stack,
            );
            throw error;
          }
        }),
      );

      // Summary logging
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;
      const totalElapsed = Date.now() - startTime;

      this.logger.log(
        `Batch processing completed: ${succeeded} succeeded, ${failed} failed in ${totalElapsed}ms`,
      );
    } catch (error) {
      const totalElapsed = Date.now() - startTime;
      this.logger.error(
        `Failed to process incoming emails after ${totalElapsed}ms: ${error.message}`,
        error.stack,
      );
    }
  }

  private async processMessage(message: Message): Promise<void> {
    const s3Event = this.sqsService.parseS3Event(message);

    if (!s3Event || !s3Event.Records || s3Event.Records.length === 0) {
      this.logger.warn('No S3 event records found in message');
      return;
    }

    this.logger.log(`Processing ${s3Event.Records.length} S3 records in parallel`);

    // Process all S3 records in parallel
    await Promise.all(s3Event.Records.map((record) => this.processS3Record(record)));
  }

  private async processS3Record(record: S3EventRecord): Promise<void> {
    const startTime = Date.now();

    try {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

      this.logger.log(`Processing S3 record: s3://${bucket}/${key}`);

      // Fetch email from S3
      const s3StartTime = Date.now();
      const emailBuffer = await this.s3Service.getObject(bucket, key);
      const s3Elapsed = Date.now() - s3StartTime;

      // Parse email
      const parseStartTime = Date.now();
      const parsedMail = await simpleParser(emailBuffer);
      const parseElapsed = Date.now() - parseStartTime;

      // Extract relay address (to address)
      const recipientEmail = this.getOriginalRecipient(parsedMail);
      if (!recipientEmail) {
        this.logger.warn('No recipient address found in email');
        return;
      }

      // Find primary email from database
      const dbStartTime = Date.now();

      // When the user replies via reply masking address
      if (recipientEmail.startsWith('reply-')) {
        const replyMasking = await this.replyMaskEmailService.findByReplyAddress(recipientEmail);

        if (!replyMasking) {
          this.logger.error(`No reply masking entity found for address: ${recipientEmail}`);
          return;
        }

        const originalSender = this.encryptionUtil.decrypt(replyMasking.senderAddress);
        const relayAddress = this.encryptionUtil.decrypt(replyMasking.receiverAddress);
        const dbElapsed = Date.now() - dbStartTime;

        const forwardStartTime = Date.now();
        await this.relayReplyToOriginalSender(originalSender, relayAddress, parsedMail);

        const forwardElapsed = Date.now() - forwardStartTime;
        const totalElapsed = Date.now() - startTime;
        this.logger.log(
          `Reply relayed in ${totalElapsed}ms (S3: ${s3Elapsed}ms, Parse: ${parseElapsed}ms, DB: ${dbElapsed}ms, Forward: ${forwardElapsed}ms) - ${key}`,
        );
        return;
      }

      // Regular relay address: look up relay_emails table
      const relayEmailEntity = await this.relayEmailRepository.findOne({
        where: { relayEmail: recipientEmail },
      });

      if (!relayEmailEntity) {
        this.logger.warn(`No relay email entity found for address: ${recipientEmail}`);
        return;
      }

      if (!relayEmailEntity.isActive) {
        this.logger.log(`Relay email is not active, skipping forward: ${recipientEmail}`);
        return;
      }

      const primaryEmail = this.encryptionUtil.decrypt(relayEmailEntity.primaryEmail);
      const relayEmail = recipientEmail;
      const dbElapsed = Date.now() - dbStartTime;

      // Forward email to primary address
      const forwardStartTime = Date.now();
      await this.forwardEmail(primaryEmail, relayEmail, parsedMail, relayEmailEntity);

      // Measure performance
      const forwardElapsed = Date.now() - forwardStartTime;
      const totalElapsed = Date.now() - startTime;

      this.logger.log(
        `S3 record processed in ${totalElapsed}ms (S3: ${s3Elapsed}ms, Parse: ${parseElapsed}ms, DB: ${dbElapsed}ms, Forward: ${forwardElapsed}ms) - ${key}`,
      );
    } catch (error) {
      const totalElapsed = Date.now() - startTime;
      this.logger.error(
        `Failed to process S3 record after ${totalElapsed}ms: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private async forwardEmail(
    primaryEmailAddress: string,
    relayEmailAddress: string,
    mail: ParsedMail,
    relayEmailEntity: RelayEmail,
  ) {
    try {
      // Parse info from mail
      const subject = mail?.subject || '(No Subject)';
      const originalSenderAddress = this.getSender(mail); // parse original email sender

      if (!originalSenderAddress) {
        throw new BadRequestException('Sender address not found');
      }

      let replyMaskEmail: string;
      try {
        const res = await this.replyMaskEmailService.create(
          originalSenderAddress,
          relayEmailAddress,
        );
        replyMaskEmail = res.replyAddress;
      } catch (error) {
        this.logger.error(`failed to get reply mask email address when forward mail `, error);
        replyMaskEmail = relayEmailAddress;
      }

      const from = `${originalSenderAddress} [via Mailhub] <${relayEmailAddress}>`;

      // Get app configuration
      const appName = this.customEnvService.get<string>('APP_NAME') || 'Mailhub';
      const appDomain = this.customEnvService.get<string>('APP_DOMAIN') || 'private-mailhub.com';

      // Build HTML header for forwarding information
      const htmlHeader = `
        <div style="max-width: 100%; margin: 0 0 20px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; padding: 1px; box-shadow: 0 2px 8px rgba(102, 126, 234, 0.15);">
            <div style="background-color: #ffffff; border-radius: 7px; padding: 12px 16px;">
              <!-- From and To info -->
              <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
                <div style="display: inline-flex; align-items: center; background: linear-gradient(135deg, #f0f4ff 0%, #e8eeff 100%); padding: 4px 10px; border-radius: 6px; font-size: 12px;">
                  <span style="color: #667eea; margin-right: 4px;">▸</span>
                  <span style="color: #4a5568; font-weight: 600;">From:</span>
                  <span style="color: #2d3748; margin-left: 6px; font-weight: 500;">${this.escapeHtml(originalSenderAddress)}</span>
                </div>
                <div style="display: inline-flex; align-items: center; background: linear-gradient(135deg, #f0f4ff 0%, #e8eeff 100%); padding: 4px 10px; border-radius: 6px; font-size: 12px;">
                  <span style="color: #667eea; margin-right: 4px;">▸</span>
                  <span style="color: #4a5568; font-weight: 600;">To:</span>
                  <span style="color: #2d3748; margin-left: 6px; font-weight: 500;">${this.escapeHtml(relayEmailAddress || '')}</span>
                </div>
              </div>

              <!-- Footer with link -->
              <div style="display: flex; align-items: center; justify-content: space-between; padding-top: 8px; border-top: 1px solid #e2e8f0;">
                <div style="font-size: 11px; color: #a0aec0;">
                  <span style="opacity: 0.7;">🔒 forwarded by</span>
                  <a href="https://${appDomain}" style="color: #667eea; text-decoration: none; font-weight: 600; margin-left: 4px; transition: color 0.2s;" target="_blank">${appName}</a>
                </div>
                <div style="font-size: 10px; color: #cbd5e0; letter-spacing: 0.5px;">
                  ✓ SECURED
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      // Prepare HTML body (always use HTML format with fancy header)
      let htmlBody: string;

      if (mail?.html) {
        // Original email is HTML
        htmlBody = htmlHeader + mail.html;
      } else if (mail?.text) {
        // Original email is plain text - convert to HTML
        htmlBody =
          htmlHeader +
          `<pre style="white-space: pre-wrap; font-family: inherit;">${this.escapeHtml(mail.text)}</pre>`;
      } else {
        // No content
        htmlBody = htmlHeader + '<p>(No content)</p>';
      }

      // Parse attachments
      const attachments = this.parseAttachments(mail);

      if (attachments.length > 0) {
        this.logger.log(`Forwarding email with ${attachments.length} attachment(s)`);
      }

      // Send email (HTML only)
      await this.sendMailService.sendMail({
        to: primaryEmailAddress, // primary email address
        from, // relay email address with display name
        resentFrom: relayEmailAddress, // relay email address
        replyTo: replyMaskEmail, // original sender email address
        subject,
        htmlBody,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      // Increment forward count (non-critical, failure is only logged)
      try {
        await this.incrementForwardCount(relayEmailAddress);
      } catch (error) {
        this.logger.error(`Failed to increment forward count`, error);
      }

      // Record the forwarding log (non-critical; the sender address is stored as a hash)
      await this.emailForwardingLogService.record(
        relayEmailEntity.userId,
        relayEmailEntity.id,
        this.encryptionUtil.hashEmailAddress(originalSenderAddress),
      );
    } catch (error) {
      this.logger.error(`Failed to forward email, `, error);
      throw error;
    }
  }

  private async relayReplyToOriginalSender(
    originalSenderAddress: string,
    relayAddress: string,
    mail: ParsedMail,
  ) {
    try {
      const subject = mail?.subject || '(No Subject)';
      const from = relayAddress;

      let htmlBody: string | undefined;
      let textBody: string | undefined;

      if (mail?.html) {
        htmlBody = typeof mail.html === 'string' ? mail.html : undefined;
      }
      if (mail?.text) {
        textBody = mail.text;
      }

      const attachments = this.parseAttachments(mail);

      await this.sendMailService.sendMail({
        to: originalSenderAddress,
        from,
        replyTo: relayAddress,
        subject,
        htmlBody,
        textBody,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      try {
        await this.incrementForwardCount(relayAddress);
      } catch (error) {
        this.logger.error(`Failed to increment forward count`, error);
      }

      this.logger.log(`Reply relayed successfully`);
    } catch (error) {
      this.logger.error(`Failed to relay reply`, error);
      throw error;
    }
  }

  /**
   * Escape HTML special characters to prevent XSS
   */
  private escapeHtml(text: string): string {
    const htmlEscapeMap: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return text.replace(/[&<>"']/g, (char) => htmlEscapeMap[char]);
  }

  /**
   * Parse attachments from ParsedMail object
   */
  private parseAttachments(mail: ParsedMail): Array<{
    filename: string;
    content: Buffer;
    contentType: string;
    contentDisposition?: string;
    cid?: string;
  }> {
    try {
      if (!mail.attachments || mail.attachments.length === 0) {
        return [];
      }

      return mail.attachments.map((attachment) => ({
        filename: attachment.filename || 'unnamed',
        content: attachment.content,
        contentType: attachment.contentType,
        contentDisposition: attachment.contentDisposition,
        cid: attachment.cid,
      }));
    } catch (error) {
      this.logger.error(`Failed to parse attachments: ${error.message}`, error.stack);
      return [];
    }
  }

  async findRelayEmailWithUserId(relayEmail: string): Promise<RelayEmail | null> {
    return await this.relayEmailRepository.findOne({
      where: { relayEmail },
    });
  }

  async findByUser(userId: bigint): Promise<RelayEmail[]> {
    return await this.relayEmailRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async findById(id: bigint, userId: bigint): Promise<RelayEmail | null> {
    return await this.relayEmailRepository.findOne({
      where: { id, userId },
    });
  }

  async deleteRelayEmail(id: bigint, userId: bigint): Promise<void> {
    const relayEmailEntity = await this.findById(id, userId);

    if (!relayEmailEntity) {
      throw new NotFoundException('Relay email not found');
    }

    // Delete from database (soft delete via TypeORM)
    await this.relayEmailRepository.softRemove(relayEmailEntity);

    // Remove from cache
    await this.cacheService.deleteRelayMailMappingCache(relayEmailEntity.relayEmail);
  }

  async incrementForwardCount(relayEmail: string): Promise<void> {
    await this.relayEmailRepository
      .createQueryBuilder()
      .update(RelayEmail)
      .set({
        forwardCount: () => 'forward_count + 1',
        lastForwardedAt: new Date(),
      })
      .where('relay_email = :relayEmail', { relayEmail })
      .execute();
  }

  async countByUser(userId: bigint): Promise<number> {
    return await this.relayEmailRepository.count({
      where: { userId },
    });
  }

  async updateDescription(id: bigint, userId: bigint, description: string): Promise<RelayEmail> {
    const relayEmail = await this.findById(id, userId);

    if (!relayEmail) {
      throw new NotFoundException('Relay email not found');
    }

    relayEmail.description = description;
    return await this.relayEmailRepository.save(relayEmail).then((res) => {
      this.logger.log(`Updated description for relay email ${id}`);
      return res;
    });
  }

  async updateActiveStatus(id: bigint, userId: bigint, isActive: boolean): Promise<RelayEmail> {
    const relayEmailEntity = await this.findById(id, userId);

    if (!relayEmailEntity) {
      throw new NotFoundException('Relay email not found');
    }

    // get primary email from cache
    const cached = await this.cacheService.findPrimaryMailFromCache(relayEmailEntity.relayEmail);

    if (!!cached && !isActive) {
      // If exists cache and pause status
      await this.cacheService.deleteRelayMailMappingCache(relayEmailEntity.relayEmail);
    } else if (!cached && isActive) {
      // If no exists cache and live status
      await this.cacheService.setRelayMailCache({
        relayEmail: relayEmailEntity.relayEmail,
        encryptedPrimaryEmail: relayEmailEntity.primaryEmail,
      });
    }

    relayEmailEntity.isActive = isActive;
    return await this.relayEmailRepository.save(relayEmailEntity).then((res) => {
      this.logger.log(`Updated active status for relay email ${id}`);
      return res;
    });
  }

  private getSender(mail: ParsedMail): string {
    try {
      // Try to get from 'from' field first
      if (mail.from?.value && Array.isArray(mail.from.value) && mail.from.value.length > 0) {
        const senderAddress = mail.from.value[0]?.address;
        if (senderAddress) {
          return senderAddress;
        }
      }

      // Fallback to Return-Path header
      const returnPath = mail.headers.get('return-path');
      if (returnPath) {
        const returnPathValue =
          typeof returnPath === 'string' ? returnPath : JSON.stringify(returnPath);

        // Extract email from Return-Path (format: <email@example.com>)
        const emailMatch = returnPathValue.match(/<(.+?)>|([^\s<>]+@[^\s<>]+)/);
        if (emailMatch) {
          return emailMatch[1] || emailMatch[2];
        }
      }

      this.logger.error(mail, 'Failed to parse sender address found in email');
      throw new InternalServerErrorException('Failed to parse sender from mail');
    } catch (error) {
      this.logger.error(`Failed to parse sender from email: ${error.message}`, error.stack);
      throw error;
    }
  }

  // parse relay email address
  private getOriginalRecipient(mail: ParsedMail): string {
    try {
      const addressObject = mail.to;

      if (!addressObject) {
        this.logger.warn('No recipient address object found in email');
        throw new InternalServerErrorException('Failed to parse mail recipient');
      }

      // Handle both single AddressObject and array of AddressObjects
      const addressArray = Array.isArray(addressObject) ? addressObject : [addressObject];

      // Find first valid email address
      for (const addr of addressArray) {
        if (addr?.value && Array.isArray(addr.value) && addr.value.length > 0) {
          const recipientAddress = addr.value[0]?.address;
          if (recipientAddress) {
            return recipientAddress;
          }
        }
      }

      this.logger.warn('No valid recipient address found in email');
      throw new InternalServerErrorException('Failed to parse mail recipient');
    } catch (error) {
      this.logger.error(`Failed to parse recipient from email: ${error.message}`, error.stack);
      throw error;
    }
  }
}
