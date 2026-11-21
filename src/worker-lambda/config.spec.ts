import { loadWorkerConfig } from './config';
import { IsolatedCaptureTransport } from './capture';

const env = {
  DATABASE_SECRET_ARN: 'db-ref',
  WORKER_SECRET_ARN: 'app-ref',
  AWS_REGION: 'region',
  MAIL_BUCKET: 'fixture',
  WORKER_STAGE: 'isolated',
};
const db = {
  host: 'db.example.invalid',
  dbname: 'test',
  username: 'test',
  password: 'fixture-only',
};
const app = { APP_NAME: 'Fixture', APP_DOMAIN: 'example.invalid', ENCRYPTION_KEY: 'fixture-only' };
const read = (id: string) => Promise.resolve(id === 'db-ref' ? db : app);

describe('worker-only bootstrap', () => {
  it('takes only the two secret references, excludes API auth config and verifies SQL identity', async () => {
    const get = jest.fn(read);
    const cfg = await loadWorkerConfig(env, get, () => 'fixture-ca');
    expect(get.mock.calls).toEqual([['db-ref'], ['app-ref']]);
    expect(cfg.db).toMatchObject({
      logging: false,
      synchronize: false,
      migrationsRun: false,
      ssl: { ca: 'fixture-ca', rejectUnauthorized: true, verifyIdentity: true },
      extra: { connectionLimit: 2 },
    });
    expect(cfg.workerEnv.get('APP_DOMAIN')).toBe('example.invalid');
  });
  it('rejects missing production provider configuration and unknown stages', async () => {
    await expect(
      loadWorkerConfig({ ...env, WORKER_STAGE: 'production' }, read, () => 'ca'),
    ).rejects.toThrow('MAILGUN_BASE_URL');
    await expect(
      loadWorkerConfig({ ...env, WORKER_STAGE: 'typo' }, read, () => 'ca'),
    ).rejects.toThrow('stage');
  });
  it('renders fixture MIME and returns a non-PII receipt without a provider or real credentials', async () => {
    const submit = await new IsolatedCaptureTransport().prepare('fixture', 'test@example.invalid', {
      subject: 'Test',
      text: 'fixture',
    });
    await expect(submit()).resolves.toMatch(/^capture:[a-f0-9]{64}$/);
  });
});
