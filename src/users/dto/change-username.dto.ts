import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ChangeUsernameDto {
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  newUsername?: string;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  encryptedNewUsername?: string;
}
