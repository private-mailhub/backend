import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { Readable } from 'stream';
import FormData from 'form-data';
import { CustomEnvService } from '../config/custom-env.service';
import { SendEmailDto } from '../aws/dto/send-email.dto';

interface MailgunMessageResponse {
  id: string;
  message: string;
}

@Injectable()
export class MailgunService {
  private readonly logger = new Logger(MailgunService.name);
  private readonly apiKey: string;
  private readonly domain: string;
  private readonly baseUrl: string;

  constructor(private customEnvService: CustomEnvService) {
    this.domain = this.customEnvService.get<string>('APP_DOMAIN');
    this.apiKey = this.customEnvService.get<string>('MAILGUN_API_KEY');
    this.baseUrl = this.customEnvService.get<string>('MAILGUN_BASE_URL');
  }

  async sendEmail(dto: SendEmailDto): Promise<void> {
    try {
      // Handle attachments if present - use MIME format
      if (dto.attachments && dto.attachments.length > 0) {
        // Create nodemailer mail options to generate MIME message
        const mailOptions: any = {
          from: dto.from,
          to: dto.to,
          subject: dto.subject,
          headers: {},
        };

        if (dto.resentFrom) {
          mailOptions.headers['Resent-From'] = dto.resentFrom;
        }

        if (dto.replyTo) {
          mailOptions.headers['Reply-To'] = dto.replyTo;
        }

        if (dto.htmlBody) {
          mailOptions.html = dto.htmlBody;
        }

        if (dto.textBody) {
          mailOptions.text = dto.textBody;
        }

        mailOptions.attachments = dto.attachments.map((att) => ({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType,
          contentDisposition: att.contentDisposition,
          cid: att.cid,
        }));

        // Generate MIME message using nodemailer
        const transporter = createTransport({
          streamTransport: true,
        });

        const info = await transporter.sendMail(mailOptions);

        let rawMessage: Buffer;
        if (Buffer.isBuffer(info.message)) {
          rawMessage = info.message;
        } else {
          rawMessage = await this.streamToBuffer(info.message);
        }

        // Send via Mailgun using MIME endpoint with form-data
        const formData = new FormData();
        formData.append('to', dto.to);
        formData.append('message', rawMessage, {
          filename: 'message.mime',
          contentType: 'message/rfc2822',
        });

        const response = await fetch(`${this.baseUrl}/v3/${this.domain}/messages.mime`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString('base64')}`,
            ...formData.getHeaders(),
          },
          body: new Uint8Array(formData.getBuffer()),
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(`Mailgun MIME API error: ${response.status} - ${errorText}`);

          if (response.status === 401 || response.status === 403) {
            throw new BadRequestException('Email domain not supported');
          }

          throw new Error(`Mailgun API error: ${response.status}`);
        }

        const result = (await response.json()) as MailgunMessageResponse;
        this.logger.log(`Email with attachments sent successfully, mailgun messageId=${result.id}`);
        return;
      }

      // No attachments - use URLSearchParams
      const params = new URLSearchParams();
      params.append('from', dto.from);
      params.append('to', dto.to);
      params.append('subject', dto.subject);
      if (dto.resentFrom) {
        params.append('h:Resent-From', dto.resentFrom);
      }

      if (dto.replyTo) {
        params.append('h:Reply-To', dto.replyTo);
      }

      // Add HTML body if present
      if (dto.htmlBody) {
        params.append('html', dto.htmlBody);
      }

      // Add text body if present
      if (dto.textBody) {
        params.append('text', dto.textBody);
      }

      // Fallback to legacy body field
      if (!dto.htmlBody && !dto.textBody && dto.body) {
        params.append('text', dto.body);
      }

      const response = await fetch(`${this.baseUrl}/v3/${this.domain}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Mailgun API error: ${response.status} - ${errorText}`);

        if (response.status === 401 || response.status === 403) {
          throw new BadRequestException('Email domain not supported');
        }

        throw new Error(`Mailgun API error: ${response.status}`);
      }

      const result = (await response.json()) as MailgunMessageResponse;
      this.logger.log(`Email sent successfully, messageId=${result.id}`);
    } catch (error) {
      this.logger.error(`Failed to send email, error=%o`, error);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw error;
    }
  }

  private streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}
