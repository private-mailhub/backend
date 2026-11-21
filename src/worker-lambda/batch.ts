/** Transport only: the shared processor owns validation, ledger and delivery decisions. */
export interface WorkerRuntime {
  processSqsBody(body: string): Promise<void>;
  checkReadiness(): Promise<void>;
}

export type BatchResponse = { batchItemFailures: { itemIdentifier: string }[] };
interface QueueRecord {
  messageId: string;
  body: string;
  eventSourceARN: string;
  eventSource: string;
}

export function makeWorkerHandler(
  bootstrap: () => Promise<WorkerRuntime>,
  sourceArn: () => string | undefined,
  report: (failures: number) => void,
) {
  let runtime: Promise<WorkerRuntime> | undefined;
  const getRuntime = () => {
    runtime ??= bootstrap().catch(() => {
      runtime = undefined; // don't poison a warm execution environment after a transient cold start failure
      throw new Error('Worker unavailable');
    });
    return runtime;
  };
  return async (event: unknown, context: { getRemainingTimeInMillis(): number }) => {
    if (event && typeof event === 'object' && 'probe' in event && !('Records' in event)) {
      if (event.probe !== 'mail-worker.readiness.v1') throw new Error('Unknown probe');
      await (await getRuntime()).checkReadiness(); // no S3 read, queue polling, provider send or ledger mutation
      return { ready: true, version: process.env.AWS_LAMBDA_FUNCTION_VERSION };
    }
    if (
      !event ||
      typeof event !== 'object' ||
      !('Records' in event) ||
      !Array.isArray(event.Records)
    ) {
      throw new Error('Expected an SQS event');
    }
    const records = event.Records as QueueRecord[];
    const expected = sourceArn();
    // An invalid ID cannot be reported via partial failure. Reject before processing *any* record.
    if (
      !expected ||
      records.some(
        (r) =>
          !r ||
          typeof r.messageId !== 'string' ||
          !r.messageId ||
          r.eventSource !== 'aws:sqs' ||
          r.eventSourceARN !== expected,
      )
    ) {
      throw new Error('Invalid SQS envelope or source');
    }
    const batchItemFailures: BatchResponse['batchItemFailures'] = [];
    for (const [index, record] of records.entries()) {
      // Standard queue only. Leave enough time to report unstarted records rather than time out mid-batch.
      if (context.getRemainingTimeInMillis() < 5000) {
        batchItemFailures.push(
          ...records.slice(index).map((r) => ({ itemIdentifier: r.messageId })),
        );
        break;
      }
      try {
        if (typeof record.body !== 'string' || !record.body) throw new Error('Empty body');
        await (await getRuntime()).processSqsBody(record.body);
      } catch {
        // Poison, transient, ambiguous delivery: never acknowledge an unconfirmed outcome or log mail/exception data.
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    report(batchItemFailures.length);
    return { batchItemFailures };
  };
}
