import { createHash } from 'node:crypto';
import { createTransport, type SendMailOptions } from 'nodemailer';

// Only selected by the isolated-account deployment. Render the real MIME without any network transport,
// disk write, recipient/subject logging or access to production provider credentials.
export class IsolatedCaptureTransport {
  async prepare(id: string, to: string, mail: SendMailOptions) {
    const capture = await createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'windows',
    }).sendMail({
      ...mail,
      to,
      messageId: `<fixture-${id}@example.invalid>`,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!Buffer.isBuffer(capture.message)) throw new Error('Fixture MIME capture failed');
    const receipt = `capture:${createHash('sha256').update(capture.message).digest('hex')}`;
    return () => Promise.resolve(receipt);
  }
}
