import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EmailForwardingLog } from './entities/email-forwarding-log.entity';

@Injectable()
export class EmailForwardingLogService {
  private readonly logger = new Logger(EmailForwardingLogService.name);

  constructor(
    @InjectRepository(EmailForwardingLog)
    private emailForwardingLogRepository: Repository<EmailForwardingLog>,
  ) {}

  /**
   * Record a forwarded email. Non-critical: any failure is only logged and never thrown,
   * so it cannot break the forwarding flow.
   *
   * @param hashedOriginalSender the original sender address, already hashed by the caller.
   */
  async record(userId: bigint, relayEmailId: bigint, hashedOriginalSender: string): Promise<void> {
    try {
      const log = this.emailForwardingLogRepository.create({
        userId,
        relayEmailId,
        originalSenderHash: hashedOriginalSender,
      });
      await this.emailForwardingLogRepository.save(log);
    } catch (error) {
      this.logger.error(
        `Failed to record email forwarding log for relay ${relayEmailId} (user ${userId})`,
        error,
      );
    }
  }
}
