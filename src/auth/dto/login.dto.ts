import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @IsNotEmpty()
  @IsString()
  encryptedUsername: string;

  @IsNotEmpty()
  @IsString()
  code: string;
}
