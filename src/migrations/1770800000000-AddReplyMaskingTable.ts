import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReplyMaskingTable1770800000000 implements MigrationInterface {
  name = 'AddReplyMaskingTable1770800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`reply_maskings\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`reply_address\` varchar(255) NOT NULL,
        \`sender_address\` varchar(255) NOT NULL,
        \`sender_address_hash\` varchar(255) NOT NULL,
        \`receiver_address\` varchar(255) NOT NULL,
        \`receiver_address_hash\` varchar(255) NOT NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`last_used_at\` datetime(6) NULL,
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(
      `CREATE INDEX \`idx_reply_address\` ON \`reply_maskings\` (\`reply_address\`)`,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_sender_receiver_hash\` ON \`reply_maskings\` (\`sender_address_hash\`, \`receiver_address_hash\`)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX \`idx_sender_receiver_hash\` ON \`reply_maskings\``);
    await queryRunner.query(`DROP INDEX \`idx_reply_address\` ON \`reply_maskings\``);
    await queryRunner.query(`DROP TABLE \`reply_maskings\``);
  }
}
