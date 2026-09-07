import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OAuthProvider } from '../../common/enums/oauth-provider.enum';

@Entity('oauth_accounts')
@Index('UQ_oauth_accounts_provider_oauth_id', ['provider', 'oauthId'], { unique: true })
@Index('UQ_oauth_accounts_user_id_provider', ['userId', 'provider'], { unique: true })
@Index('idx_oauth_accounts_user_id', ['userId'])
export class OAuthAccount {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: bigint;

  @Column({
    name: 'user_id',
    type: 'bigint',
  })
  userId: bigint;

  @Column({
    type: 'varchar',
    length: 50,
    enum: OAuthProvider,
    name: 'provider',
  })
  provider: OAuthProvider;

  @Column({
    name: 'oauth_id',
    type: 'varchar',
    length: 255,
  })
  oauthId: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}
