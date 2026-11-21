import { Injectable } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { CustomEnvService } from '../config/custom-env.service';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid S3 notification');
  return value as Record<string, unknown>;
}
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid SQS notification JSON');
  }
}
export function s3Records(body: string): unknown[] {
  let event = object(json(body));
  if (event.Type === 'Notification' && typeof event.Message === 'string')
    event = object(json(event.Message));
  if (event.Event === 's3:TestEvent' && event.Service === 'Amazon S3') return [];
  if (!Array.isArray(event.Records) || !event.Records.length) throw new Error('Missing S3 records');
  return event.Records;
}

export interface MailObject {
  id: string;
  bucket: string;
  key: string;
  version?: string;
  etag?: string;
}
export function mailObject(raw: unknown, allowedBucket: string): MailObject {
  const record = object(raw);
  if (
    record.eventSource !== 'aws:s3' ||
    typeof record.eventName !== 'string' ||
    !record.eventName.startsWith('ObjectCreated:')
  ) {
    throw new Error('Not an S3 object creation');
  }
  const s3 = object(record.s3),
    bucket = object(s3.bucket).name,
    item = object(s3.object);
  if (
    typeof bucket !== 'string' ||
    bucket !== allowedBucket ||
    typeof item.key !== 'string' ||
    !item.key
  ) {
    throw new Error('Unexpected S3 object location');
  }
  const key = decodeURIComponent(item.key.replace(/\+/g, ' '));
  const version = item.versionId;
  if (version != null && (typeof version !== 'string' || !version))
    throw new Error('Invalid S3 version');
  let discriminator: string[];
  let etag: string | undefined;
  if (typeof version === 'string' && version !== 'null') {
    discriminator = ['version', version];
  } else {
    // A sequencer identifies the event but cannot select an old object body. Do
    // not deliver the latest object's mail for a notification about a prior write.
    if (
      typeof item.sequencer !== 'string' ||
      !/^[a-f0-9]+$/i.test(item.sequencer) ||
      typeof item.eTag !== 'string' ||
      !/^[a-zA-Z0-9-]+$/.test(item.eTag)
    ) {
      throw new Error('Unversioned notification requires sequencer and ETag');
    }
    discriminator = ['sequencer', item.sequencer.toLowerCase().replace(/^0+(?=.)/, '')];
    etag = `"${item.eTag}"`;
  }
  const id = createHash('sha256')
    .update(JSON.stringify([bucket, key, ...discriminator]))
    .digest('hex');
  return { id, bucket, key, version: typeof version === 'string' ? version : undefined, etag };
}

@Injectable()
export class MailObjectReader {
  private readonly client: S3Client;
  constructor(config: CustomEnvService) {
    this.client = new S3Client({ region: config.get<string>('AWS_REGION') });
  }
  async read(item: MailObject): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: item.bucket,
        Key: item.key,
        VersionId: item.version,
        IfMatch: item.etag,
      }),
    );
    if (!response.Body) throw new Error('S3 object has no body');
    return Buffer.from(await response.Body.transformToByteArray());
  }
}
