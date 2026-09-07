import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLogTables1770900000000 implements MigrationInterface {
  name = 'AddLogTables1770900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`user_activity_logs\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`user_id\` bigint NOT NULL,
        \`activity_type\` varchar(255) NOT NULL,
        \`activity_details\` text NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(
      `CREATE INDEX \`idx_user_id_created_at\` ON \`user_activity_logs\` (\`user_id\`, \`created_at\` DESC)`,
    );
    await queryRunner.query(`
      ALTER TABLE \`user_activity_logs\`
      ADD CONSTRAINT \`FK_user_activity_logs_user_id\`
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE \`email_forwarding_logs\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`user_id\` bigint NOT NULL,
        \`relay_email_id\` bigint NOT NULL,
        \`original_sender_hash\` varchar(255) NOT NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(
      `CREATE INDEX \`idx_user_id_created_at\` ON \`email_forwarding_logs\` (\`user_id\`, \`created_at\` DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_relay_email_id_created_at\` ON \`email_forwarding_logs\` (\`relay_email_id\`, \`created_at\` DESC)`,
    );
    await queryRunner.query(`
      ALTER TABLE \`email_forwarding_logs\`
      ADD CONSTRAINT \`FK_email_forwarding_logs_user_id\`
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE \`email_forwarding_logs\`
      ADD CONSTRAINT \`FK_email_forwarding_logs_relay_email_id\`
      FOREIGN KEY (\`relay_email_id\`) REFERENCES \`relay_emails\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`email_forwarding_logs\` DROP FOREIGN KEY \`FK_email_forwarding_logs_relay_email_id\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`email_forwarding_logs\` DROP FOREIGN KEY \`FK_email_forwarding_logs_user_id\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_relay_email_id_created_at\` ON \`email_forwarding_logs\``,
    );
    await queryRunner.query(`DROP INDEX \`idx_user_id_created_at\` ON \`email_forwarding_logs\``);
    await queryRunner.query(`DROP TABLE \`email_forwarding_logs\``);

    await queryRunner.query(
      `ALTER TABLE \`user_activity_logs\` DROP FOREIGN KEY \`FK_user_activity_logs_user_id\``,
    );
    await queryRunner.query(`DROP INDEX \`idx_user_id_created_at\` ON \`user_activity_logs\``);
    await queryRunner.query(`DROP TABLE \`user_activity_logs\``);
  }
}
