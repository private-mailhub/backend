import { IsEmail, IsNotEmpty } from 'class-validator';

export class FindPrimaryEmailDto {
  @IsNotEmpty()
  @IsEmail()
  relayEmail: string;
}
