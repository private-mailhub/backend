import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOAuthTokenColumns1770700000000 implements MigrationInterface {
  name = 'AddOAuthTokenColumns1770700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`users\` ADD \`gh_oauth_token\` varchar(512) NULL`);
    await queryRunner.query(`ALTER TABLE \`users\` ADD \`goog_oauth_token\` varchar(512) NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`goog_oauth_token\``);
    await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`gh_oauth_token\``);
  }
}
