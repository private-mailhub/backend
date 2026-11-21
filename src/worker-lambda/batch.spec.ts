import { makeWorkerHandler } from './batch';

const record = (messageId: string, body = messageId) => ({
  messageId,
  body,
  eventSource: 'aws:sqs',
  eventSourceARN: 'allowed',
});
const context = { getRemainingTimeInMillis: () => 30000 };
const setup = () => {
  const processSqsBody = jest.fn((body: string) =>
    body === 'bad' ? Promise.reject(new Error('private')) : Promise.resolve(),
  );
  const checkReadiness = jest.fn(() => Promise.resolve());
  const boot = jest.fn(() => Promise.resolve({ processSqsBody, checkReadiness }));
  const report = jest.fn();
  return {
    handle: makeWorkerHandler(boot, () => 'allowed', report),
    boot,
    report,
    processSqsBody,
    checkReadiness,
  };
};

describe('SQS Lambda', () => {
  it('returns only failed SQS IDs, even when the middle record fails, and reuses its runtime', async () => {
    const { handle, boot, report, processSqsBody } = setup();
    expect(
      await handle({ Records: [record('a'), record('b', 'bad'), record('c')] }, context),
    ).toEqual({ batchItemFailures: [{ itemIdentifier: 'b' }] });
    expect(processSqsBody.mock.calls).toEqual([['a'], ['bad'], ['c']]);
    expect(report).toHaveBeenCalledWith(1);
    await handle({ Records: [record('d')] }, context);
    expect(boot).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign sources before side effects and preserves unstarted records near timeout', async () => {
    const { handle, boot } = setup();
    await expect(
      handle({ Records: [record('a'), { ...record('b'), eventSourceARN: 'other' }] }, context),
    ).rejects.toThrow('source');
    expect(
      await handle({ Records: [record('a'), record('b')] }, { getRemainingTimeInMillis: () => 10 }),
    ).toEqual({ batchItemFailures: [{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }] });
    expect(boot).not.toHaveBeenCalled();
  });
  it('uses a read-only probe and does not mask a failed bootstrap', async () => {
    const { handle, boot, checkReadiness, processSqsBody } = setup();
    boot.mockRejectedValueOnce(new Error('private'));
    await expect(handle({ probe: 'mail-worker.readiness.v1' }, context)).rejects.toThrow(
      'Worker unavailable',
    );
    expect(await handle({ probe: 'mail-worker.readiness.v1' }, context)).toMatchObject({
      ready: true,
    });
    expect(checkReadiness).toHaveBeenCalledTimes(1);
    expect(processSqsBody).not.toHaveBeenCalled();
  });
});
