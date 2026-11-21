import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ConfigService } from '@nestjs/config';
import { CustomEnvService } from '../config/custom-env.service';

// Explicit managed-runtime dependency: the Node.js 24 Lambda runtime supplies AWS SDK v3.
// Resolve lazily, so requiring the packaged handler off AWS never looks up credentials or starts I/O.
interface SecretsSdk {
  SecretsManagerClient: new (opts: { maxAttempts: number }) => {
    send(command: unknown): Promise<{ SecretString?: string }>;
  };
  GetSecretValueCommand: new (opts: { SecretId: string }) => unknown;
}
async function readSecret(arn: string): Promise<Record<string, unknown>> {
  const sdk = createRequire(__filename)('@aws-sdk/client-secrets-manager') as SecretsSdk;
  const { SecretString } = await new sdk.SecretsManagerClient({ maxAttempts: 2 }).send(
    new sdk.GetSecretValueCommand({ SecretId: arn }),
  );
  if (!SecretString) throw new Error('Missing managed secret');
  return JSON.parse(SecretString) as Record<string, unknown>;
}
function required(obj: Record<string, unknown>, key: string) {
  const v = obj[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Missing worker setting: ${key}`);
  return v;
}
export async function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
  read = readSecret,
  ca = () => readFileSync('/var/runtime/ca-cert.pem', 'utf8'),
) {
  const [db, app] = await Promise.all([
    read(required(env, 'DATABASE_SECRET_ARN')),
    read(required(env, 'WORKER_SECRET_ARN')),
  ]);
  const stage = required(env, 'WORKER_STAGE');
  if (stage !== 'production' && stage !== 'isolated') throw new Error('Invalid worker stage');
  const mailgunBase = stage === 'production' ? required(app, 'MAILGUN_BASE_URL') : undefined;
  if (
    mailgunBase &&
    !['https://api.mailgun.net', 'https://api.eu.mailgun.net'].includes(mailgunBase)
  )
    throw new Error('Untrusted outbound endpoint');
  const domain = required(app, 'APP_DOMAIN');
  if (!/^(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$/i.test(domain)) throw new Error('Invalid mail domain');
  const values = {
    NODE_ENV: 'production',
    WORKER_STAGE: stage,
    AWS_REGION: required(env, 'AWS_REGION'),
    AWS_S3_EMAIL_BUCKET: required(env, 'MAIL_BUCKET'),
    APP_NAME: required(app, 'APP_NAME'),
    APP_DOMAIN: domain,
    ENCRYPTION_KEY: required(app, 'ENCRYPTION_KEY'),
    LEGACY_ENCRYPTION_KEYS: app.LEGACY_ENCRYPTION_KEYS ?? '',
    MAILGUN_BASE_URL: mailgunBase,
    MAILGUN_API_KEY: stage === 'production' ? required(app, 'MAILGUN_API_KEY') : undefined,
  };
  const port = Number(db.port ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid database port');
  // No secrets in Lambda configuration, logs, .env, artifacts or the process environment.
  const ssl = {
    ca: ca(),
    minVersion: 'TLSv1.2' as const,
    rejectUnauthorized: true,
    verifyIdentity: true,
  };
  return {
    stage,
    workerEnv: new CustomEnvService(new ConfigService(values)),
    db: {
      type: 'mysql' as const,
      connectorPackage: 'mysql2' as const,
      host: required(db, 'host'),
      port,
      database: required(db, 'dbname'),
      username: required(db, 'username'),
      password: required(db, 'password'),
      ssl,
      extra: {
        ssl,
        connectionLimit: 2,
        waitForConnections: true,
        queueLimit: 2,
        enableKeepAlive: true,
      },
      connectTimeout: 4500,
      synchronize: false,
      migrationsRun: false,
      logging: false,
      retryAttempts: 1,
    },
  };
}
