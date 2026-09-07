import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUniqueIndexesForOAuthIds1771000000000 implements MigrationInterface {
  name = 'AddUniqueIndexesForOAuthIds1771000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`users\` ADD UNIQUE INDEX \`UQ_users_gh_oauth\` (\`gh_oauth\`)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` ADD UNIQUE INDEX \`UQ_users_aapl_oauth\` (\`aapl_oauth\`)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` ADD UNIQUE INDEX \`UQ_users_goog_oauth\` (\`goog_oauth\`)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`users\` DROP INDEX \`UQ_users_goog_oauth\``);
    await queryRunner.query(`ALTER TABLE \`users\` DROP INDEX \`UQ_users_aapl_oauth\``);
    await queryRunner.query(`ALTER TABLE \`users\` DROP INDEX \`UQ_users_gh_oauth\``);
  }
}
