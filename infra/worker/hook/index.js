'use strict';
// The managed Lambda Node.js 24 runtime provides AWS SDK v3. No keys, URLs, or mail payloads are logged.
exports.makeHook =
  ({ invoke, report }, target) =>
  async (event) => {
    const { DeploymentId, LifecycleEventHookExecutionId } = event;
    if (!DeploymentId || !LifecycleEventHookExecutionId)
      throw new Error('Missing lifecycle identifiers');
    let status = 'Failed';
    try {
      const version = target.split(':').at(-1);
      if (!/^[1-9]\d*$/.test(version)) throw new Error('A published version is required');
      const response = await invoke(target, { probe: 'mail-worker.readiness.v1' });
      if (response.StatusCode !== 200 || response.FunctionError) throw new Error('Probe failed');
      const payload = JSON.parse(Buffer.from(response.Payload).toString('utf8'));
      if (payload.ready !== true || payload.version !== version) throw new Error('Wrong candidate');
      status = 'Succeeded';
    } catch {
      /* Do not emit SDK exceptions, payloads, or secrets. */
    }
    await report({
      deploymentId: DeploymentId,
      lifecycleEventHookExecutionId: LifecycleEventHookExecutionId,
      status,
    });
  };
exports.handler = async (event) => {
  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
  const {
    CodeDeployClient,
    PutLifecycleEventHookExecutionStatusCommand,
  } = require('@aws-sdk/client-codedeploy');
  const lambda = new LambdaClient({ maxAttempts: 1 });
  const deploy = new CodeDeployClient({ maxAttempts: 3 });
  return exports.makeHook(
    {
      invoke: (FunctionName, payload) =>
        lambda.send(
          new InvokeCommand({ FunctionName, Payload: Buffer.from(JSON.stringify(payload)) }),
        ),
      report: (input) => deploy.send(new PutLifecycleEventHookExecutionStatusCommand(input)),
    },
    process.env.CANDIDATE_ARN,
  )(event);
};
