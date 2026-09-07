import { Module } from '@nestjs/common';
import { SendMailService } from './send-mail.service';
import { MailgunService } from './mailgun.service';
import { AwsModule } from 'src/aws/aws.module';
import { CustomEnvService } from 'src/config/custom-env.service';

@Module({
  imports: [AwsModule],
  providers: [CustomEnvService, SendMailService, MailgunService],
  exports: [SendMailService],
})
export class MailModule {}
