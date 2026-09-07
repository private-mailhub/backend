import { IsEmail } from 'class-validator';
import { ParsedMail } from 'mailparser';

export class ForwardEmailDto {
  @IsEmail()
  to: string;
  parsedMail: ParsedMail;
}
