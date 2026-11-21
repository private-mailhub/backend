import 'reflect-metadata';
import { makeWorkerHandler } from './batch';
import { bootstrapWorker } from './runtime';

export const handler = makeWorkerHandler(
  bootstrapWorker,
  () => process.env.SOURCE_QUEUE_ARN,
  (failures) => {
    // EMF captures partial failures that do NOT count towards Lambda's Errors metric.
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: 'Mailhub/Worker',
              Dimensions: [['FunctionName']],
              Metrics: [{ Name: 'FailedRecords', Unit: 'Count' }],
            },
          ],
        },
        FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
        FailedRecords: failures,
      }),
    );
  },
);
