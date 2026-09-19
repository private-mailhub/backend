import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  username?: string;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  encryptedUsername?: string;

  @IsNotEmpty()
  @IsString()
  code: string;
}
