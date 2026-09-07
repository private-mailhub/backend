import { Module } from '@nestjs/common';
import { SesService } from './ses/ses.service';
import { S3Service } from './s3/s3.service';
import { SqsService } from './sqs/sqs.service';

@Module({
  providers: [SesService, S3Service, SqsService],
  exports: [SesService, S3Service, SqsService],
})
export class AwsModule {}
