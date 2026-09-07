import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { SubscriptionTier } from '../../common/enums/subscription-tier.enum';
import { RelayEmail } from '../../relay-emails/entities/relay-email.entity';
import { UserRole, UserStatus } from '../user.enums';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: bigint;

  @Column({ type: 'varchar', length: 255 })
  username: string;

  @Column({
    type: 'char',
    length: 64,
    unique: true,
    name: 'username_hash',
  })
  usernameHash: string;

  @Column({
    type: 'varchar',
    length: 50,
    enum: UserRole,
    default: UserRole.USER,
    name: 'role',
  })
  role: UserRole;

  @Column({
    type: 'varchar',
    length: 50,
    enum: UserStatus,
    default: UserStatus.ACTIVE,
    name: 'status',
  })
  status: UserStatus;

  @Column({
    type: 'enum',
    enum: SubscriptionTier,
    default: SubscriptionTier.FREE,
    name: 'subscription_tier',
  })
  subscriptionTier: SubscriptionTier;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;

  @Column({
    name: 'deactivated_at',
    type: 'datetime',
    nullable: true,
  })
  deactivatedAt: Date | null;

  @Column({
    name: 'deleted_at',
    type: 'datetime',
    nullable: true,
  })
  deletedAt: Date | null;

  @Column({
    name: 'last_logined_at',
    type: 'datetime',
    nullable: true,
  })
  lastLoginedAt: Date | null;

  @Column({
    name: 'gh_oauth',
    type: 'varchar',
    length: 255,
    nullable: true,
    unique: true,
  })
  githubOAuth: string | null;

  @Column({
    name: 'aapl_oauth',
    type: 'varchar',
    length: 255,
    nullable: true,
    unique: true,
  })
  appleOAuth: string | null;

  @Column({
    name: 'goog_oauth',
    type: 'varchar',
    length: 255,
    nullable: true,
    unique: true,
  })
  googleOAuth: string | null;

  @Column({
    name: 'gh_oauth_token',
    type: 'varchar',
    length: 512,
    nullable: true,
  })
  githubOAuthToken: string | null;

  @Column({
    name: 'goog_oauth_token',
    type: 'varchar',
    length: 512,
    nullable: true,
  })
  googleOAuthToken: string | null;

  @OneToMany(() => RelayEmail, (relayEmail) => relayEmail.user)
  relayEmails: RelayEmail[];
}
