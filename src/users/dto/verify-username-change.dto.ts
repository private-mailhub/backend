import { IsString, Length } from 'class-validator';

export class VerifyUsernameChangeDto {
  @IsString()
  @Length(6, 6)
  code: string;
}
