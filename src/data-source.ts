import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { User } from './users/entities/user.entity';
import { OAuthAccount } from './users/entities/oauth-account.entity';
import { RelayEmail } from './relay-emails/entities/relay-email.entity';
import { ReplyMasking } from './relay-emails/entities/reply-masking.entity';
import { UserActivityLog } from './logs/entities/user-activity-log.entity';
import { EmailForwardingLog } from './logs/entities/email-forwarding-log.entity';

dotenv.config();

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT || '3306'),
  database: process.env.DATABASE_NAME,
  username: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  entities: [User, OAuthAccount, RelayEmail, ReplyMasking, UserActivityLog, EmailForwardingLog],
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
  logging: process.env.NODE_ENV !== 'production',
});
