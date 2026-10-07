import { IsBoolean, IsIn, IsNotEmpty, IsString, MaxLength, Matches } from 'class-validator';

export class StartCliDeviceAuthorizationDto {
  @IsIn(['mailhub-cli'])
  clientName: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  deviceName: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  cliVersion: string;

  @IsNotEmpty()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  pollSecretHash: string;
}

export class PollCliDeviceTokenDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  deviceCode: string;

  @IsNotEmpty()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  pollSecret: string;
}

export class CliUserCodeDto {
  @IsNotEmpty()
  @IsString()
  @Matches(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/)
  userCode: string;
}

export class DecideCliDeviceAuthorizationDto extends CliUserCodeDto {
  @IsBoolean()
  approve: boolean;
}
