import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type DeliveryState = 'ready' | 'preparing' | 'sending' | 'unknown' | 'sent' | 'skipped';

@Entity('mail_deliveries')
@Index('idx_mail_deliveries_reconcile', ['state', 'updatedAt'])
export class MailDelivery {
  @PrimaryColumn({ name: 'record_id', type: 'char', length: 64 })
  recordId: string;

  @Column({ type: 'varchar', length: 16, default: 'ready' })
  state: DeliveryState;

  @Column({ type: 'char', length: 36, nullable: true })
  owner: string | null;

  @Column({ name: 'lease_until', type: 'datetime', precision: 6, nullable: true })
  leaseUntil: Date | null;

  @Column({ name: 'skip_reason', type: 'varchar', length: 32, nullable: true })
  skipReason: string | null;

  @Column({ name: 'provider_id', type: 'varchar', length: 255, nullable: true })
  providerId: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt: Date;
}
