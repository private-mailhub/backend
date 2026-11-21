import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMailDeliveries1795219200000 implements MigrationInterface {
  public async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE mail_deliveries (
      record_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      state VARCHAR(16) NOT NULL DEFAULT 'ready', owner CHAR(36) NULL,
      lease_until DATETIME(6) NULL, skip_reason VARCHAR(32) NULL, provider_id VARCHAR(255) NULL,
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      INDEX idx_mail_deliveries_reconcile (state, updated_at)
    ) ENGINE=InnoDB`);
  }

  public down(): Promise<void> {
    // Application rollback is compatible with retaining this additive table. Dropping
    // it loses the record of which provider operations must never be replayed.
    return Promise.reject(
      new Error('Retain mail_deliveries on rollback; destructive revert is not supported'),
    );
  }
}
