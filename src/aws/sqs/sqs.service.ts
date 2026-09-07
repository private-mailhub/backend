import { Injectable, Logger } from '@nestjs/common';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { CustomEnvService } from '../../config/custom-env.service';

export interface S3EventRecord {
  eventVersion: string;
  eventSource: string;
  awsRegion: string;
  eventTime: string;
  eventName: string;
  s3: {
    bucket: {
      name: string;
      arn: string;
    };
    object: {
      key: string;
      size: number;
    };
  };
}

export interface S3Event {
  Records: S3EventRecord[];
}

@Injectable()
export class SqsService {
  private readonly logger = new Logger(SqsService.name);
  private readonly sqsClient: SQSClient;
  private readonly queueUrl: string;

  constructor(private readonly customEnvService: CustomEnvService) {
    const accessKeyId = this.customEnvService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.customEnvService.get<string>('AWS_SECRET_ACCESS_KEY');
    const region = this.customEnvService.get<string>('AWS_REGION');

    this.sqsClient = new SQSClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.queueUrl = this.customEnvService.get<string>('AWS_SQS_QUEUE_URL');
  }

  async receiveMessages(maxMessages: number = 10): Promise<Message[]> {
    try {
      const command = new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: 20, // Long polling
        VisibilityTimeout: 60, // 60 seconds to process
        MessageAttributeNames: ['All'],
      });

      const response = await this.sqsClient.send(command);
      const messages = response.Messages || [];

      if (messages.length > 0) {
        this.logger.log(`Received ${messages.length} messages from SQS`);
      }

      return messages;
    } catch (error) {
      this.logger.error(`Failed to receive messages from SQS: ${error.message}`, error.stack);
      throw error;
    }
  }

  async deleteMessage(receiptHandle: string): Promise<void> {
    try {
      const command = new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      });

      await this.sqsClient.send(command);
      this.logger.log('Message deleted from SQS');
    } catch (error) {
      this.logger.error(`Failed to delete message from SQS: ${error.message}`, error.stack);
      throw error;
    }
  }

  parseS3Event(message: Message): S3Event | null {
    try {
      if (!message.Body) {
        this.logger.warn('Message body is empty');
        return null;
      }

      const body = JSON.parse(message.Body);

      // S3 event notifications come wrapped in an SNS message if using SNS topic
      // Direct S3 -> SQS notifications have Records directly
      if (body.Records) {
        return body as S3Event;
      }

      // If wrapped in SNS, extract the message
      if (body.Message) {
        const s3Event = JSON.parse(body.Message);
        return s3Event as S3Event;
      }

      this.logger.warn('Unable to parse S3 event from message');
      return null;
    } catch (error) {
      this.logger.error(`Failed to parse S3 event: ${error.message}`, error.stack);
      return null;
    }
  }
}
