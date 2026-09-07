import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('relay_emails')
export class RelayEmail {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: bigint;

  @Column({ type: 'bigint', name: 'user_id' })
  @Index('idx_user_id')
  userId: bigint;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'primary_email',
  })
  @Index('idx_primary_email')
  primaryEmail: string;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'relay_email',
  })
  @Index('idx_relay_email')
  relayEmail: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    type: 'boolean',
    default: true,
    name: 'is_active',
  })
  isActive: boolean;

  @Column({
    type: 'bigint',
    default: 0,
    name: 'forward_count',
  })
  forwardCount: bigint;

  @Column({
    type: 'datetime',
    nullable: true,
    name: 'last_forwarded_at',
  })
  lastForwardedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;

  @DeleteDateColumn({
    name: 'paused_at',
    type: 'datetime',
    nullable: true,
  })
  pausedAt: Date | null;

  @ManyToOne(() => User, (user) => user.relayEmails, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
