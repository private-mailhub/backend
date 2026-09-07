import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('user_activity_logs')
@Index('idx_user_id_created_at', ['userId', 'createdAt'])
export class UserActivityLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: bigint;

  @Column({ type: 'bigint', name: 'user_id' })
  userId: bigint;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'activity_type',
  })
  activityType: string;

  @Column({
    type: 'text',
    nullable: true,
    name: 'activity_details',
  })
  activityDetails: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
