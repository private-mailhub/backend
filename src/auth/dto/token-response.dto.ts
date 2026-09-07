import { IsNotEmpty } from 'class-validator';

export class CreateTokenResponseDto {
  @IsNotEmpty()
  accessToken: string;
}

export class TokenPayloadDto {
  userId: bigint;
  username: string;
}
