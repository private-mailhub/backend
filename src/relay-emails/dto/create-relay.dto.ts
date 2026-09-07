import { IsEmail, IsNotEmpty } from 'class-validator';

export class CreateRelayDto {
  @IsNotEmpty()
  @IsEmail()
  primaryEmail: string;
}
