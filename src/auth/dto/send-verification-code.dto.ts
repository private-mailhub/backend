import { IsNotEmpty, IsString } from 'class-validator';

export class SendVerificationCodeDto {
  @IsNotEmpty()
  @IsString()
  encryptedUsername: string;
}
