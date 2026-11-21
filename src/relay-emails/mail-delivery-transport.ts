import { Injectable } from '@nestjs/common';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { createTransport, type SendMailOptions } from 'nodemailer';
import { CustomEnvService } from '../config/custom-env.service';

// Preparation may fail and is safe to retry. The returned operation is the one
// external submission: never retry it, even on a timeout or a malformed receipt.
export type PreparedSend = () => Promise<string>;

@Injectable()
export class MailDeliveryTransport {
  constructor(private readonly config: CustomEnvService) {}

  async prepare(id: string, to: string, mail: SendMailOptions): Promise<PreparedSend> {
    const domain = this.config.get<string>('APP_DOMAIN');
    const mime = await createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'windows',
    }).sendMail({
      ...mail,
      to: { address: to, name: '' },
      messageId: `<mailhub-${id}@${domain}>`,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!Buffer.isBuffer(mime.message)) throw new Error('MIME preparation failed');
    if (this.config.get<string>('NODE_ENV') !== 'production') {
      // Keep the existing local SES sandbox route; an SDK retry could submit twice.
      const ses = new SESClient({ region: this.config.get<string>('AWS_REGION'), maxAttempts: 1 });
      const command = new SendRawEmailCommand({
        Destinations: [to],
        RawMessage: { Data: mime.message },
      });
      return async () => {
        try {
          const receipt = await ses.send(command);
          if (!receipt.MessageId) throw new Error('Missing SES receipt');
          return receipt.MessageId;
        } finally {
          ses.destroy();
        }
      };
    }
    const endpoint = new URL(
      `/v3/${encodeURIComponent(domain)}/messages.mime`,
      this.config.get<string>('MAILGUN_BASE_URL'),
    );
    if (endpoint.protocol !== 'https:') throw new Error('Mailgun requires HTTPS');
    const key = this.config.get<string>('MAILGUN_API_KEY');
    const form = new FormData();
    form.set('to', to);
    form.set(
      'message',
      new Blob([new Uint8Array(mime.message)], { type: 'message/rfc822' }),
      'message.mime',
    );
    const request = new Request(endpoint, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`api:${key}`).toString('base64')}` },
      body: form,
      redirect: 'error',
    });
    return async () => {
      const response = await fetch(request, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Mailgun returned ${response.status}`);
      const receipt = await response.json();
      if (typeof receipt?.id !== 'string' || !receipt.id || receipt.id.length > 255)
        throw new Error('Invalid Mailgun receipt');
      return receipt.id;
    };
  }
}
