import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { CustomEnvService } from '../../src/config/custom-env.service';
import { MailRecordModule } from '../../src/relay-emails/mail-record.module';
import { MailRecordProcessor } from '../../src/relay-emails/mail-record-processor';
import { MailDeliveryTransport } from '../../src/relay-emails/mail-delivery-transport';
import { MailObjectReader } from '../../src/relay-emails/mail-object';

const config = {
  get: (key: string) =>
    key === 'ENCRYPTION_KEY' ? Buffer.alloc(32, 1).toString('base64') : 'us-east-1',
  getWithDefault: (_key: string, d: string) => d,
};
@Global()
@Module({
  providers: [
    { provide: CustomEnvService, useValue: config },
    {
      provide: getDataSourceToken(),
      useValue: { entityMetadatas: [], options: { type: 'mysql' }, getRepository: () => ({}) },
    },
  ],
  exports: [CustomEnvService, getDataSourceToken()],
})
class FakeHost {}
class Capture {
  prepare() {
    return Promise.resolve(() => Promise.resolve('capture-only'));
  }
}
test('isolated Nest application resolves the shared processor with a feature-local no-send transport', async () => {
  const context = await Test.createTestingModule({
    imports: [FakeHost, MailRecordModule.withTransport(Capture)],
  }).compile();
  try {
    expect(context.get(MailDeliveryTransport)).toBeInstanceOf(Capture);
    expect(context.get(MailRecordProcessor)).toBeInstanceOf(MailRecordProcessor);
  } finally {
    await context.close();
  }
});
test('reader fetches the immutable version or uses the If-Match precondition exactly', async () => {
  const sdk = S3Client.prototype as unknown as {
    send(command: GetObjectCommand): Promise<unknown>;
  };
  const read = jest
    .spyOn(sdk, 'send')
    .mockImplementation(() =>
      Promise.resolve({ Body: { transformToByteArray: () => Promise.resolve(Uint8Array.of(1)) } }),
    );
  try {
    const reader = new MailObjectReader(config as never);
    await reader.read({ id: 'x', bucket: 'synthetic', key: 'a b', version: 'v1' });
    await reader.read({ id: 'y', bucket: 'synthetic', key: 'a b', etag: '"abc"' });
    expect(read.mock.calls[0][0].input).toEqual({
      Bucket: 'synthetic',
      Key: 'a b',
      VersionId: 'v1',
      IfMatch: undefined,
    });
    expect(read.mock.calls[1][0].input).toEqual({
      Bucket: 'synthetic',
      Key: 'a b',
      VersionId: undefined,
      IfMatch: '"abc"',
    });
  } finally {
    read.mockRestore();
  }
});
