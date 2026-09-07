import { plainToInstance } from 'class-transformer';
import { IsString, IsNumber, IsEnum, validateSync, IsOptional } from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Local = 'local',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment;

  @IsNumber()
  PORT: number;

  @IsString()
  APP_NAME: string;

  @IsString()
  APP_DOMAIN: string;

  @IsString()
  DATABASE_HOST: string;

  @IsNumber()
  DATABASE_PORT: number;

  @IsString()
  DATABASE_NAME: string;

  @IsString()
  DATABASE_USERNAME: string;

  @IsString()
  DATABASE_PASSWORD: string;

  @IsString()
  REDIS_HOST: string;

  @IsNumber()
  REDIS_PORT: number;

  @IsNumber()
  @IsOptional()
  REDIS_TTL?: number;

  @IsString()
  JWT_SECRET: string;

  @IsNumber()
  VERIFICATION_CODE_EXPIRATION: number;

  @IsNumber()
  VERIFICATION_CODE_MAX_ATTEMPTS: number;

  @IsString()
  AWS_ACCESS_KEY_ID: string;

  @IsString()
  AWS_SECRET_ACCESS_KEY: string;

  @IsString()
  AWS_REGION: string;

  @IsString()
  AWS_S3_EMAIL_BUCKET: string;

  @IsString()
  AWS_SQS_QUEUE_NAME: string;

  @IsString()
  @IsOptional()
  AWS_SQS_QUEUE_URL?: string;

  @IsString()
  NO_REPLY_ADDRESS: string;

  @IsString()
  CONTACT_ADDRESS: string;

  @IsString()
  CORS_ORIGINS: string;

  @IsString()
  ENCRYPTION_KEY: string;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }

  return validatedConfig;
}
