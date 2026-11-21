'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
function simulate(t, overrides = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const account = '000000000001',
    prefix = `arn:aws:sqs:us-east-1:${account}:`;
  const env = {
    PATH: `${tmp}:${process.env.PATH}`,
    STAGE: 'isolated',
    EXPECTED_ACCOUNT: account,
    PRODUCTION_ACCOUNT: '000000000002',
    AWS_REGION: 'us-east-1',
    SOURCE_ARN: prefix + 'source',
    DLQ_ARN: prefix + 'dlq',
    MAIL_BUCKET: 'fixture-mail',
    DB_SECRET: `arn:aws:secretsmanager:us-east-1:${account}:secret:db-fixture`,
    APP_SECRET: `arn:aws:secretsmanager:us-east-1:${account}:secret:app-fixture`,
    SUBNETS: 'subnet-fixture',
    SECURITY_GROUP: 'sg-fixture',
    ARTIFACT_BUCKET: 'fixture-artifacts',
    CFN_ROLE: `arn:aws:iam::${account}:role/fixture`,
    GITHUB_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    RECEIVES: '4',
    VISIBILITY: '270',
    STATE: 'Disabled',
    LOG: path.join(tmp, 'log'),
    ...overrides,
  };
  writeFileSync(
    path.join(tmp, 'aws'),
    `#!/bin/sh
set -eu
case "$1:$2" in
sts:get-caller-identity) echo "$EXPECTED_ACCOUNT";;
s3api:head-bucket) :;;
sqs:get-queue-url) echo "$4";;
sqs:get-queue-attributes) if [ "$4" = source ]; then jq -n --arg a "$SOURCE_ARN" --arg d "$DLQ_ARN" --arg n "$RECEIVES" --arg v "$VISIBILITY" '{QueueArn:$a,VisibilityTimeout:$v,MessageRetentionPeriod:"3600",RedrivePolicy:({deadLetterTargetArn:$d,maxReceiveCount:$n}|tojson)}'; else jq -n --arg a "$DLQ_ARN" '{QueueArn:$a,MessageRetentionPeriod:"86400"}'; fi;;
lambda:list-event-source-mappings) jq -n --arg s "$STATE" '{EventSourceMappings:[{State:$s}]}';;
*) echo 'unexpected AWS command' >&2; exit 2;; esac\n`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(tmp, 'sam'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$LOG"\n', {
    mode: 0o755,
  });
  const r = spawnSync('bash', ['scripts/worker/prepare-change-set.sh'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return { code: r.status, cmd: existsSync(env.LOG) ? readFileSync(env.LOG, 'utf8') : '' };
}
test('prepares only a change set with existing resources and no activation', (t) => {
  const r = simulate(t);
  assert.equal(r.code, 0);
  assert.match(r.cmd, /--no-execute-changeset/);
  assert.doesNotMatch(r.cmd, /--resolve-s3|Enabled=true/);
});
for (const [title, overrides] of [
  ['isolated deployment in production account', { PRODUCTION_ACCOUNT: '000000000001' }],
  ['queue visibility too short', { VISIBILITY: '45' }],
  ['active mapping', { STATE: 'Enabled' }],
  ['unbounded retries', { RECEIVES: '10' }],
])
  test(`rejects ${title}`, (t) => {
    const r = simulate(t, overrides);
    assert.notEqual(r.code, 0);
    assert.equal(r.cmd, '');
  });

test('publish requires a second gate and never modifies the mapping', (t) => {
  assert.notEqual(simulate(t, { OPERATION: 'publish' }).code, 0);
  const r = simulate(t, { OPERATION: 'publish', PUBLISH_GATE: 'true' });
  assert.equal(r.code, 0);
  assert.match(r.cmd, /--no-confirm-changeset/);
  assert.doesNotMatch(r.cmd, /mapping.yaml|--no-execute-changeset/);
});
