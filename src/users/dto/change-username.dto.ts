import { IsNotEmpty, IsString } from 'class-validator';

export class ChangeUsernameDto {
  @IsNotEmpty()
  @IsString()
  encryptedNewUsername: string;
}
