import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserActivityLog } from './entities/user-activity-log.entity';
import { UserActivityType } from '../common/enums/activity-type.enum';

@Injectable()
export class UserActivityLogService {
  private readonly logger = new Logger(UserActivityLogService.name);

  constructor(
    @InjectRepository(UserActivityLog)
    private userActivityLogRepository: Repository<UserActivityLog>,
  ) {}

  /**
   * Record a user activity. Non-critical: any failure is only logged and never thrown,
   * so it cannot break the calling flow (e.g. login).
   */
  async record(userId: bigint, activityType: UserActivityType, details?: string): Promise<void> {
    try {
      const log = this.userActivityLogRepository.create({
        userId,
        activityType,
        activityDetails: details ?? null,
      });
      await this.userActivityLogRepository.save(log);
    } catch (error) {
      this.logger.error(
        `Failed to record user activity (${activityType}) for user ${userId}`,
        error,
      );
    }
  }
}
