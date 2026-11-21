'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeHook } = require('../../infra/worker/hook/index.js');
const event = { DeploymentId: 'd-test', LifecycleEventHookExecutionId: 'token' };
for (const [name, result, status] of [
  ['exact version ready', { ready: true, version: '2' }, 'Succeeded'],
  ['wrong version', { ready: true, version: '1' }, 'Failed'],
  ['unhealthy', { ready: false, version: '2' }, 'Failed'],
  ['failed invocation', null, 'Failed'],
])
  test(name, async () => {
    let received, invoked;
    await makeHook(
      {
        invoke: (target, payload) => {
          invoked = payload;
          if (!result) throw Error('secret');
          return { StatusCode: 200, Payload: Buffer.from(JSON.stringify(result)) };
        },
        report: (value) => {
          received = value;
        },
      },
      'arn:aws:lambda:r:a:function:f:2',
    )(event);
    assert.deepEqual(invoked, { probe: 'mail-worker.readiness.v1' });
    assert.deepEqual(received, {
      deploymentId: 'd-test',
      lifecycleEventHookExecutionId: 'token',
      status,
    });
  });
