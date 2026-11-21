import { DatabaseSync } from 'node:sqlite';
import type { Repository } from 'typeorm';
import { MailRecordProcessor } from '../../src/relay-emails/mail-record-processor';
import { MailDeliveryLedger } from '../../src/relay-emails/mail-delivery-ledger';
import { MailDeliveryTransport } from '../../src/relay-emails/mail-delivery-transport';
import { MailDelivery } from '../../src/relay-emails/entities/mail-delivery.entity';
import { mailObject, s3Records } from '../../src/relay-emails/mail-object';
import { QueuePollerService } from '../../src/relay-emails/queue-poller.service';
import { simpleParser } from 'mailparser';

const bucket = 'synthetic-inbox';
function record(key = 'object+one', version: string | null = 'v1') {
  return {
    eventSource: 'aws:s3',
    eventName: 'ObjectCreated:Put',
    s3: {
      bucket: { name: bucket },
      object: { key, versionId: version, sequencer: '00a', eTag: 'abc' },
    },
  };
}
const envelope = (...records: unknown[]) => JSON.stringify({ Records: records });
const normal = envelope(record());
const body = (to = 'alias@example.test') =>
  Buffer.from(
    `From: sender@example.test\r\nTo: ${to}\r\nSubject: Synthetic\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nletter <safe>\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="test.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC/w==\r\n--b--\r\n`,
  );
const id = mailObject(record(), bucket).id;
const cfg = {
  get: (key: string) =>
    ({
      AWS_S3_EMAIL_BUCKET: bucket,
      APP_DOMAIN: 'example.test',
      APP_NAME: 'Mailhub',
      NODE_ENV: 'production',
      MAILGUN_API_KEY: 'synthetic',
      MAILGUN_BASE_URL: 'https://api.example.invalid',
    })[key],
};

// In-memory repository test double. Execute the production CAS predicates and unique
// key locally, translating only MySQL's UPSERT and two clock expressions. No network.
function localLedger() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    `CREATE TABLE mail_deliveries (record_id TEXT PRIMARY KEY, state TEXT DEFAULT 'ready', owner TEXT, lease_until INTEGER, provider_id TEXT, skip_reason TEXT)`,
  );
  const rows = {
    query: (sql: string, params: Array<string | null>) => {
      const local = sql
        .replace(
          'ON DUPLICATE KEY UPDATE record_id = record_id',
          'ON CONFLICT(record_id) DO NOTHING',
        )
        .replace('DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 120 SECOND)', '(unixepoch()+120)')
        .replaceAll('UTC_TIMESTAMP(6)', 'unixepoch()');
      const st = db.prepare(local);
      if (sql.startsWith('SELECT')) return Promise.resolve(st.all(...params));
      return Promise.resolve({ affectedRows: st.run(...params).changes });
    },
  };
  const ledger = new MailDeliveryLedger(rows as unknown as Repository<MailDelivery>);
  return {
    db,
    ledger,
    state: (target = id) =>
      db.prepare('SELECT * FROM mail_deliveries WHERE record_id=?').get(target),
  };
}
function harness() {
  const store = localLedger();
  const objects = { read: jest.fn().mockResolvedValue(body()) };
  const relay = {
    relayEmail: 'alias@example.test',
    primaryEmail: 'owner@example.test',
    userId: 1n,
    id: 2n,
    isActive: true,
  };
  const query = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const relays = { findOne: jest.fn().mockResolvedValue(relay), createQueryBuilder: () => query };
  const masks = {
    create: jest.fn().mockResolvedValue({ replyAddress: 'reply-mask@example.test' }),
    findByReplyAddress: jest.fn(),
  };
  const crypt = { decrypt: (v: string) => v, hashEmailAddress: () => 'senderhash' };
  const submit = jest.fn().mockResolvedValue('provider-123');
  const transport = { prepare: jest.fn().mockResolvedValue(submit) };
  const log = { record: jest.fn() };
  const make = () =>
    new MailRecordProcessor(
      cfg as never,
      store.ledger,
      objects as never,
      relays as never,
      masks as never,
      crypt as never,
      transport as never,
      log as never,
    );
  return {
    ...store,
    objects,
    relays,
    query,
    masks,
    submit,
    transport,
    log,
    relay,
    p: make(),
    make,
  };
}
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.db.close();
  jest.restoreAllMocks();
});

test('uses canonical bucket/key/version or sequencer; pins unversioned fetch via event ETag', () => {
  expect(mailObject(record('object%20one'), bucket).id).toBe(id);
  expect(mailObject(record('object+one', 'v2'), bucket).id).not.toBe(id);
  const unv = record('object+one', null),
    object = mailObject(unv, bucket);
  expect(object).toMatchObject({ key: 'object one', etag: '"abc"' });
  unv.s3.object.sequencer = 'A';
  expect(mailObject(unv, bucket).id).toBe(object.id);
  unv.s3.object.eTag = '';
  expect(() => mailObject(unv, bucket)).toThrow();
  expect(() => mailObject(record(), 'wrong')).toThrow();
  expect(() => s3Records('not JSON')).toThrow();
  expect(() => s3Records('{"Records":[]}')).toThrow();
  expect(s3Records('{"Event":"s3:TestEvent","Service":"Amazon S3"}')).toEqual([]);
});
test('two owners contend; only expired pre-send is reclaimable and stale owners cannot send/release', async () => {
  const lease = await h.ledger.claim(id);
  if (!lease) throw Error();
  await expect(h.ledger.claim(id)).rejects.toThrow('busy');
  h.db.exec('UPDATE mail_deliveries SET lease_until=0');
  const newer = await h.ledger.claim(id);
  if (!newer) throw Error();
  await h.ledger.release(lease);
  await expect(h.ledger.beginSend(lease)).rejects.toThrow();
  await h.ledger.beginSend(newer);
  h.db.exec('UPDATE mail_deliveries SET lease_until=0');
  await expect(h.ledger.claim(id)).rejects.toThrow('reconciliation');
  expect(h.state()?.state).toBe('sending');
});
test('known pre-send MIME, S3 and reply-mask failures release immediately; send occurs only after fence', async () => {
  h.objects.read.mockRejectedValueOnce(Error('S3 transient'));
  h.masks.create.mockRejectedValueOnce(Error('DB transient'));
  h.transport.prepare.mockRejectedValueOnce(Error('MIME transient'));
  for (let i = 0; i < 3; i++) {
    await expect(h.p.processSqsBody(normal)).rejects.toThrow();
    expect(h.state()?.state).toBe('ready');
    expect(h.submit).not.toHaveBeenCalled();
  }
  h.submit.mockImplementation(() => {
    expect(h.state()?.state).toBe('sending');
    return Promise.resolve('mailgun-id');
  });
  await h.p.processSqsBody(normal);
  const sns = JSON.stringify({ Type: 'Notification', Message: normal });
  await h.make().processSqsBody(sns);
  expect(h.submit).toHaveBeenCalledTimes(1);
  expect(h.state()).toMatchObject({ state: 'sent', provider_id: 'mailgun-id' });
  expect(h.transport.prepare.mock.calls.at(-1)?.[2]).toMatchObject({
    from: { address: 'alias@example.test' },
    replyTo: { address: 'reply-mask@example.test' },
    html: expect.stringContaining('&lt;safe&gt;'),
    attachments: [{ filename: 'test.bin', content: Buffer.from([0, 1, 2, 255]) }],
  });
});
test.each(['provider', 'commit', 'lost fence response'] as const)(
  'fails closed across subsequent deliveries on %s ambiguity',
  async (stage) => {
    if (stage === 'provider') h.submit.mockRejectedValueOnce(Error('timeout'));
    if (stage === 'commit')
      jest.spyOn(h.ledger, 'sent').mockRejectedValueOnce(Error('DB unavailable'));
    if (stage === 'lost fence response') {
      const begin = h.ledger.beginSend.bind(h.ledger);
      jest.spyOn(h.ledger, 'beginSend').mockImplementationOnce(async (c) => {
        await begin(c);
        throw Error('connection lost');
      });
    }
    await expect(h.p.processSqsBody(normal)).rejects.toThrow();
    expect(h.state()?.state).toBe(stage === 'provider' ? 'unknown' : 'sending');
    await expect(h.make().processSqsBody(normal)).rejects.toThrow();
    expect(h.submit).toHaveBeenCalledTimes(stage === 'lost fence response' ? 0 : 1);
  },
);
test('partial progress proceeds past malformed and transient records; successes stay deduped', async () => {
  h.objects.read.mockRejectedValueOnce(Error());
  const a = record('A'),
    b = record('B');
  await expect(h.p.processSqsBody(envelope({}, a, b))).rejects.toThrow();
  expect(h.submit).toHaveBeenCalledTimes(1);
  await expect(h.p.processSqsBody(envelope({}, a, b))).rejects.toThrow();
  expect(h.submit).toHaveBeenCalledTimes(2);
  await h.p.processSqsBody(envelope(a, b));
  expect(h.submit).toHaveBeenCalledTimes(2);
});
test('durably skips inactive/unknown mappings, preserving a masked reply with attachments', async () => {
  h.relays.findOne
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ ...h.relay, isActive: false });
  const one = record('1'),
    two = record('2');
  await h.p.processSqsBody(envelope(one, two));
  expect(h.state(mailObject(one, bucket).id)?.skip_reason).toBe('unknown_relay');
  expect(h.state(mailObject(two, bucket).id)?.skip_reason).toBe('inactive_relay');
  h.objects.read.mockResolvedValue(body('reply-mask@example.test'));
  h.masks.findByReplyAddress.mockResolvedValueOnce(null).mockResolvedValueOnce({
    senderAddress: 'sender@example.test',
    receiverAddress: 'alias@example.test',
  });
  await h.p.processSqsBody(envelope(record('3'), record('4')));
  expect(h.state(mailObject(record('3'), bucket).id)?.skip_reason).toBe('unknown_reply');
  expect(h.transport.prepare).toHaveBeenCalledWith(
    expect.any(String),
    'sender@example.test',
    expect.objectContaining({
      replyTo: { name: '', address: 'alias@example.test' },
      attachments: [expect.objectContaining({ content: Buffer.from([0, 1, 2, 255]) })],
    }),
  );
  expect(h.submit).toHaveBeenCalledTimes(1);
});
test('PM2 fallback running the same release acknowledges a Lambda success without another provider call', async () => {
  await h.p.processSqsBody(normal);
  const sqs = {
    receiveMessages: jest.fn().mockResolvedValue([
      { Body: normal, ReceiptHandle: 'a' },
      { Body: 'broken', ReceiptHandle: 'b' },
    ]),
    deleteMessage: jest.fn(),
  };
  const previous = process.env.WORKER_MODE;
  process.env.WORKER_MODE = 'true';
  try {
    const pm2 = new QueuePollerService(sqs as never, h.make());
    pm2.onModuleInit();
    await pm2.pollSQS();
    await pm2.onModuleDestroy();
  } finally {
    if (previous === undefined) delete process.env.WORKER_MODE;
    else process.env.WORKER_MODE = previous;
  }
  expect(sqs.deleteMessage.mock.calls).toEqual([['a']]);
  expect(h.submit).toHaveBeenCalledTimes(1);
});
test('Mailgun preparation performs zero requests; submission sends masked MIME and stable reconciliation id', async () => {
  const post = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ id: 'receipt' }), { status: 200 }));
  const transport = new MailDeliveryTransport(cfg as never);
  const submit = await transport.prepare(id, 'owner@example.test', {
    from: 'alias@example.test',
    replyTo: 'reply-mask@example.test',
    subject: 'test',
    attachments: [{ filename: 'x.bin', content: Buffer.from([1, 2, 3]) }],
  });
  expect(post).not.toHaveBeenCalled();
  await expect(submit()).resolves.toBe('receipt');
  expect(post).toHaveBeenCalledTimes(1);
  const req = post.mock.calls[0][0] as Request;
  expect(req.url).toBe('https://api.example.invalid/v3/example.test/messages.mime');
  const form = await req.formData();
  const mf = form.get('message') as Blob;
  const mime = await simpleParser(Buffer.from(await mf.arrayBuffer()));
  expect(mime.messageId).toBe(`<mailhub-${id}@example.test>`);
  expect(mime.attachments[0].content).toEqual(Buffer.from([1, 2, 3]));
  expect(mime.replyTo?.value[0].address).toBe('reply-mask@example.test');
});
