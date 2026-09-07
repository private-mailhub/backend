import { IsEmail, IsOptional, IsString, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  contentDisposition?: string;
  cid?: string;
}

export class SendEmailDto {
  @IsEmail()
  to: string; // primary email address

  /**
   * relay email address with display name
   * or team official email address
   * e.g. xxx@gmail.com [via Mailhub] <xxx@private-mailhub.com>
   */
  @IsEmail()
  from: string;

  @IsOptional()
  @IsEmail()
  replyTo?: string; // original email sender

  /**
   * relay email address
   * e.g. xxx@private-mailhub.com
   */
  @IsOptional()
  @IsEmail()
  resentFrom?: string; // relay email address

  @IsString()
  subject: string;

  @IsOptional()
  @IsString()
  htmlBody?: string;

  @IsOptional()
  @IsString()
  textBody?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmailAttachment)
  attachments?: EmailAttachment[];

  /**
   * @deprecated Use htmlBody and/or textBody instead for better email client compatibility
   */
  @IsOptional()
  @IsString()
  body?: string;
}
