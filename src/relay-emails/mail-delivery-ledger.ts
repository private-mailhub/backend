import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { MailDelivery, type DeliveryState } from './entities/mail-delivery.entity';

export interface DeliveryClaim {
  id: string;
  owner: string;
}
export type SkipReason = 'unknown_relay' | 'inactive_relay' | 'unknown_reply';

// All operations are committed, conditional statements against the same InnoDB primary.
// No transaction/DB lock is held across S3, MIME construction or the provider request.
@Injectable()
export class MailDeliveryLedger {
  constructor(@InjectRepository(MailDelivery) private readonly rows: Repository<MailDelivery>) {}

  async claim(id: string): Promise<DeliveryClaim | null> {
    const owner = randomUUID();
    await this.rows.query(
      `INSERT INTO mail_deliveries (record_id) VALUES (?) ON DUPLICATE KEY UPDATE record_id = record_id`,
      [id],
    );
    const result = await this.rows.query(
      `UPDATE mail_deliveries SET state='preparing', owner=?, lease_until=DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 120 SECOND)
       WHERE record_id=? AND (state='ready' OR (state='preparing' AND lease_until <= UTC_TIMESTAMP(6)))`,
      [owner, id],
    );
    if (result.affectedRows === 1) return { id, owner };
    const [row] = await this.rows.query('SELECT state FROM mail_deliveries WHERE record_id=?', [
      id,
    ]);
    const state: DeliveryState | undefined = row?.state;
    if (state === 'sent' || state === 'skipped') return null;
    if (state === 'sending' || state === 'unknown')
      throw new Error(`Delivery requires reconciliation: ${id}`);
    throw new Error(`Delivery claim busy: ${id}`);
  }

  async release({ id, owner }: DeliveryClaim): Promise<void> {
    // A stale owner must never clear another claim or a possibly committed send fence.
    await this.rows.query(
      `UPDATE mail_deliveries SET state='ready', owner=NULL, lease_until=NULL
      WHERE record_id=? AND owner=? AND state='preparing'`,
      [id, owner],
    );
  }

  skip(claim: DeliveryClaim, reason: SkipReason): Promise<void> {
    return this.change(claim, 'preparing', 'skipped', null, reason);
  }
  beginSend(claim: DeliveryClaim): Promise<void> {
    return this.change(claim, 'preparing', 'sending');
  }
  sent(claim: DeliveryClaim, providerId: string): Promise<void> {
    return this.change(claim, 'sending', 'sent', providerId);
  }
  unknown(claim: DeliveryClaim): Promise<void> {
    return this.change(claim, 'sending', 'unknown');
  }

  private async change(
    { id, owner }: DeliveryClaim,
    from: 'preparing' | 'sending',
    to: DeliveryState,
    providerId: string | null = null,
    reason: SkipReason | null = null,
  ): Promise<void> {
    const result = await this.rows.query(
      `UPDATE mail_deliveries SET state=?, lease_until=NULL, provider_id=?, skip_reason=?
      WHERE record_id=? AND owner=? AND state=? ${from === 'preparing' ? 'AND lease_until > UTC_TIMESTAMP(6)' : ''}`,
      [to, providerId, reason, id, owner, from],
    );
    if (result.affectedRows !== 1) throw new Error(`Delivery fence not acquired: ${id}`);
  }
}
