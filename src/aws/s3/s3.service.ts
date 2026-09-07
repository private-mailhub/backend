import { Injectable, Logger } from '@nestjs/common';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { CustomEnvService } from '../../config/custom-env.service';
import { Readable } from 'stream';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3Client: S3Client;

  constructor(private readonly customEnvService: CustomEnvService) {
    const accessKeyId = this.customEnvService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.customEnvService.get<string>('AWS_SECRET_ACCESS_KEY');
    const region = this.customEnvService.get<string>('AWS_REGION');

    this.s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.logger.log('S3 Service initialized');
  }

  async getObject(bucket: string, key: string): Promise<Buffer> {
    try {
      this.logger.debug(`Fetching object from S3: s3://${bucket}/${key}`);

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error('S3 object body is empty');
      }

      const stream = response.Body as Readable;
      const chunks: Buffer[] = [];

      return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      });
    } catch (error) {
      this.logger.error(`Failed to get object from S3: ${error.message}`, error.stack);
      throw error;
    }
  }

  async getObjectAsString(bucket: string, key: string): Promise<string> {
    const buffer = await this.getObject(bucket, key);
    return buffer.toString('utf-8');
  }
}
