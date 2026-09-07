import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  MessageRejected,
  SESClient,
  SendEmailCommand,
  SendRawEmailCommand,
} from '@aws-sdk/client-ses';
import { CustomEnvService } from '../../config/custom-env.service';
import { SendEmailDto } from '../dto/send-email.dto';
import { createTransport } from 'nodemailer';
import { Readable } from 'stream';

@Injectable()
export class SesService {
  private readonly logger = new Logger(SesService.name);
  private sesClient: SESClient;

  constructor(private customEnvService: CustomEnvService) {
    const region = this.customEnvService.get<string>('AWS_REGION');
    const accessKeyId = this.customEnvService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.customEnvService.get<string>('AWS_SECRET_ACCESS_KEY');

    this.sesClient = new SESClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async sendEmail(dto: SendEmailDto): Promise<void> {
    try {
      // If there are attachments, use SendRawEmailCommand
      if (dto.attachments && dto.attachments.length > 0) {
        await this.sendEmailWithAttachments(dto);
      } else {
        // Use regular SendEmailCommand for emails without attachments
        const sesCommand = this.generateCommand(dto);
        await this.sesClient.send(sesCommand);
      }
      this.logger.log(`email sent successfully`);
    } catch (error) {
      this.logger.error(`Failed to send email, error=%o`, error);

      // Check if error is MessageRejected (unauthorized email domain)
      if (error instanceof MessageRejected) {
        throw new BadRequestException('Email domain not supported');
      }

      // Re-throw other errors
      throw error;
    }
  }

  private async sendEmailWithAttachments(dto: SendEmailDto): Promise<void> {
    // Create nodemailer mail options
    const mailOptions: any = {
      from: dto.from,
      to: dto.to,
      subject: dto.subject,
    };

    if (dto.replyTo) {
      mailOptions.replyTo = dto.replyTo;
    }

    // Add HTML body if present
    if (dto.htmlBody) {
      mailOptions.html = dto.htmlBody;
    }

    // Add text body if present
    if (dto.textBody) {
      mailOptions.text = dto.textBody;
    }

    // Fallback to legacy body field
    if (!dto.htmlBody && !dto.textBody && dto.body) {
      mailOptions.html = dto.body;
    }

    // Add attachments
    if (dto.attachments && dto.attachments.length > 0) {
      mailOptions.attachments = dto.attachments.map((att) => ({
        filename: att.filename,
        content: att.content,
        contentType: att.contentType,
        contentDisposition: att.contentDisposition,
        cid: att.cid,
      }));
    }

    // Create a nodemailer transporter (we won't actually send through it)
    const transporter = createTransport({
      streamTransport: true,
    });

    // Generate the raw MIME message
    const info = await transporter.sendMail(mailOptions);

    // Convert to Buffer (handle both Buffer and Readable types)
    let rawMessage: Buffer;
    if (Buffer.isBuffer(info.message)) {
      rawMessage = info.message;
    } else {
      rawMessage = await this.streamToBuffer(info.message);
    }

    // Send via SES using SendRawEmailCommand
    const sendRawEmailCommand = new SendRawEmailCommand({
      RawMessage: {
        Data: rawMessage,
      },
    });

    await this.sesClient.send(sendRawEmailCommand);
  }

  private streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  private generateCommand(dto: SendEmailDto) {
    // Build email body - support both new (htmlBody/textBody) and legacy (body) formats
    const bodyConfig: any = {};

    if (dto.htmlBody) {
      bodyConfig.Html = {
        Data: dto.htmlBody,
        Charset: 'UTF-8',
      };
    }

    if (dto.textBody) {
      bodyConfig.Text = {
        Data: dto.textBody,
        Charset: 'UTF-8',
      };
    }

    // Fallback to legacy 'body' field if new fields are not provided
    if (!dto.htmlBody && !dto.textBody && dto.body) {
      bodyConfig.Html = {
        Data: dto.body,
        Charset: 'UTF-8',
      };
    }

    // At least one body type must be provided
    if (!bodyConfig.Html && !bodyConfig.Text) {
      throw new Error('Email must have at least one body type (HTML or Text)');
    }

    return new SendEmailCommand({
      Source: dto.from,
      Destination: {
        ToAddresses: [dto.to],
      },
      ...(dto.replyTo && { ReplyToAddresses: [dto.replyTo] }),
      Message: {
        Subject: {
          Data: dto.subject,
          Charset: 'UTF-8',
        },
        Body: bodyConfig,
      },
    });
  }
}
