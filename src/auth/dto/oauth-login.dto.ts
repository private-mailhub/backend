import { IsNotEmpty, IsString } from 'class-validator';

export class OAuthGithubDto {
  @IsNotEmpty()
  @IsString()
  code: string;

  @IsNotEmpty()
  @IsString()
  redirectUri: string;
}

export class OAuthGoogleDto {
  @IsNotEmpty()
  @IsString()
  code: string;

  @IsNotEmpty()
  @IsString()
  redirectUri: string;
}

export class OAuthAppleDto {
  @IsNotEmpty()
  @IsString()
  idToken: string;
}
