import { QueuePollerService } from '../../src/relay-emails/queue-poller.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const previous = process.env.WORKER_MODE;
beforeEach(() => {
  process.env.WORKER_MODE = 'true';
});
afterEach(() => {
  if (previous === undefined) delete process.env.WORKER_MODE;
  else process.env.WORKER_MODE = previous;
});
test('drain waits for an outstanding receive; never starts newly returned work or polls again', async () => {
  const longPoll = deferred<{ Body: string; ReceiptHandle: string }[]>();
  const sqs = { receiveMessages: jest.fn(() => longPoll.promise), deleteMessage: jest.fn() };
  const work = { processSqsBody: jest.fn() };
  const service = new QueuePollerService(sqs as never, work as never);
  service.onModuleInit();
  const batch = service.pollSQS();
  let done = false;
  const drain = service.onModuleDestroy().then(() => {
    done = true;
  });
  await service.pollSQS();
  expect(done).toBe(false);
  longPoll.resolve([{ Body: 'synthetic', ReceiptHandle: 'r' }]);
  await Promise.all([drain, batch]);
  await service.pollSQS();
  expect(sqs.receiveMessages).toHaveBeenCalledTimes(1);
  expect(work.processSqsBody).not.toHaveBeenCalled();
  expect(sqs.deleteMessage).not.toHaveBeenCalled();
});
test('drain waits for a started body and its delete; a failed body is never deleted', async () => {
  const started = deferred<void>(),
    finished = deferred<void>(),
    deleting = deferred<void>(),
    deleted = deferred<void>();
  const sqs = {
    receiveMessages: jest.fn().mockResolvedValue([
      { Body: 'good', ReceiptHandle: 'r' },
      { Body: 'bad', ReceiptHandle: 'b' },
    ]),
    deleteMessage: jest.fn(() => {
      deleting.resolve();
      return deleted.promise;
    }),
  };
  const work = {
    processSqsBody: jest.fn((body: string) => {
      if (body === 'bad') return Promise.reject(Error('transient'));
      started.resolve();
      return finished.promise;
    }),
  };
  const service = new QueuePollerService(sqs as never, work as never);
  service.onModuleInit();
  const batch = service.pollSQS();
  await started.promise;
  let done = false;
  const drain = service.onModuleDestroy().then(() => {
    done = true;
  });
  await service.pollSQS();
  expect(done).toBe(false);
  finished.resolve();
  await deleting.promise;
  expect(done).toBe(false);
  deleted.resolve();
  await Promise.all([batch, drain]);
  expect(sqs.deleteMessage.mock.calls).toEqual([['r']]);
  expect(sqs.receiveMessages).toHaveBeenCalledTimes(1);
});
