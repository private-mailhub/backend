import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SendVerificationCodeDto {
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  username?: string;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  encryptedUsername?: string;
}
