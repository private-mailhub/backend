import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOAuthIdentities1771100000000 implements MigrationInterface {
  name = 'AddOAuthIdentities1771100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`oauth_accounts\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`user_id\` bigint NOT NULL,
        \`provider\` varchar(50) NOT NULL,
        \`oauth_id\` varchar(255) NOT NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        UNIQUE INDEX \`UQ_oauth_accounts_provider_oauth_id\` (\`provider\`, \`oauth_id\`),
        UNIQUE INDEX \`UQ_oauth_accounts_user_id_provider\` (\`user_id\`, \`provider\`),
        INDEX \`idx_oauth_accounts_user_id\` (\`user_id\`),
        PRIMARY KEY (\`id\`),
        CONSTRAINT \`FK_oauth_accounts_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB
    `);

    await queryRunner.query(`
      INSERT INTO \`oauth_accounts\` (\`user_id\`, \`provider\`, \`oauth_id\`)
      SELECT \`id\`, 'github', \`gh_oauth\`
      FROM \`users\`
      WHERE \`gh_oauth\` IS NOT NULL
    `);

    await queryRunner.query(`
      INSERT INTO \`oauth_accounts\` (\`user_id\`, \`provider\`, \`oauth_id\`)
      SELECT \`id\`, 'apple', \`aapl_oauth\`
      FROM \`users\`
      WHERE \`aapl_oauth\` IS NOT NULL
    `);

    await queryRunner.query(`
      INSERT INTO \`oauth_accounts\` (\`user_id\`, \`provider\`, \`oauth_id\`)
      SELECT \`id\`, 'google', \`goog_oauth\`
      FROM \`users\`
      WHERE \`goog_oauth\` IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`oauth_accounts\` DROP FOREIGN KEY \`FK_oauth_accounts_user_id\``,
    );
    await queryRunner.query(`DROP INDEX \`idx_oauth_accounts_user_id\` ON \`oauth_accounts\``);
    await queryRunner.query(
      `DROP INDEX \`UQ_oauth_accounts_user_id_provider\` ON \`oauth_accounts\``,
    );
    await queryRunner.query(
      `DROP INDEX \`UQ_oauth_accounts_provider_oauth_id\` ON \`oauth_accounts\``,
    );
    await queryRunner.query(`DROP TABLE \`oauth_accounts\``);
  }
}
