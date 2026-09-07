import { MigrationInterface, QueryRunner } from 'typeorm';

export class SyncSchemaWithEntities1770589629266 implements MigrationInterface {
  name = 'SyncSchemaWithEntities1770589629266';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop old FK and indexes that need renaming
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` DROP FOREIGN KEY \`FK_relay_emails_user\``,
    );
    await queryRunner.query(`DROP INDEX \`idx_relay_address\` ON \`relay_emails\``);
    await queryRunner.query(`DROP INDEX \`UQ_username_hash\` ON \`users\``);

    // Modify column types safely (MODIFY instead of DROP+ADD to preserve data)
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` MODIFY COLUMN \`primary_email\` varchar(255) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` MODIFY COLUMN \`relay_email\` varchar(255) NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE \`relay_emails\` MODIFY COLUMN \`description\` text NULL`);
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` CHANGE \`created_at\` \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` CHANGE \`updated_at\` \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` CHANGE \`paused_at\` \`paused_at\` datetime(6) NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY COLUMN \`username\` varchar(255) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY COLUMN \`username_hash\` char(64) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY COLUMN \`subscription_tier\` enum('FREE', 'PRO') NOT NULL DEFAULT 'FREE'`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` CHANGE \`created_at\` \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` CHANGE \`updated_at\` \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)`,
    );

    // Recreate indexes with correct names
    await queryRunner.query(
      `ALTER TABLE \`users\` ADD UNIQUE INDEX \`IDX_c7a1485d3f23b1b6d5a565813d\` (\`username_hash\`)`,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_primary_email\` ON \`relay_emails\` (\`primary_email\`)`,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_relay_email\` ON \`relay_emails\` (\`relay_email\`)`,
    );

    // Recreate FK with TypeORM-managed name
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` ADD CONSTRAINT \`FK_c994626f9143f8e2cd72a6879c6\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop new FK and indexes
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` DROP FOREIGN KEY \`FK_c994626f9143f8e2cd72a6879c6\``,
    );
    await queryRunner.query(`DROP INDEX \`idx_relay_email\` ON \`relay_emails\``);
    await queryRunner.query(`DROP INDEX \`idx_primary_email\` ON \`relay_emails\``);
    await queryRunner.query(`ALTER TABLE \`users\` DROP INDEX \`IDX_c7a1485d3f23b1b6d5a565813d\``);

    // Revert column types
    await queryRunner.query(
      `ALTER TABLE \`users\` CHANGE \`updated_at\` \`updated_at\` datetime(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` CHANGE \`created_at\` \`created_at\` datetime(0) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY COLUMN \`subscription_tier\` varchar(50) NOT NULL DEFAULT 'FREE'`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY COLUMN \`username_hash\` varchar(256) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY COLUMN \`username\` varchar(256) NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` CHANGE \`paused_at\` \`paused_at\` datetime(0) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` CHANGE \`updated_at\` \`updated_at\` datetime(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` CHANGE \`created_at\` \`created_at\` datetime(0) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` MODIFY COLUMN \`description\` varchar(256) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` MODIFY COLUMN \`relay_email\` varchar(256) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` MODIFY COLUMN \`primary_email\` char(128) NOT NULL`,
    );

    // Restore original indexes
    await queryRunner.query(
      `CREATE UNIQUE INDEX \`UQ_username_hash\` ON \`users\` (\`username_hash\`)`,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_relay_address\` ON \`relay_emails\` (\`relay_email\`)`,
    );

    // Restore original FK
    await queryRunner.query(
      `ALTER TABLE \`relay_emails\` ADD CONSTRAINT \`FK_relay_emails_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
