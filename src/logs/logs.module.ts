import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserActivityLog } from './entities/user-activity-log.entity';
import { EmailForwardingLog } from './entities/email-forwarding-log.entity';
import { UserActivityLogService } from './user-activity-log.service';
import { EmailForwardingLogService } from './email-forwarding-log.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserActivityLog, EmailForwardingLog])],
  providers: [UserActivityLogService, EmailForwardingLogService],
  exports: [UserActivityLogService, EmailForwardingLogService],
})
export class LogsModule {}
