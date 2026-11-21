'use strict';
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { deploy, portOf } = require('../deploy/codedeploy/transaction.cjs');
const { selectSlot } = require('../deploy/codedeploy/host.cjs');
const { equal } = require('../deploy/codedeploy/compare-tree.cjs');
const old = '# preserved\nserver 127.0.0.1:8080 max_fails=3 fail_timeout=30s; # original\n';
const rel = '/backend/releases/' + 'a'.repeat(40);
const app = (cwd, port) => ({
  name: `mailhub-server-${port}`,
  id: port,
  pid: port + 88,
  since: 555,
  cwd,
  script: cwd + '/dist/main.js',
  port,
  apiMode: true,
});
function host() {
  const h = {
    disk: old,
    serving: 8080,
    db: {},
    apps: { 8080: app('/old', 8080) },
    actions: [],
    draining: false,
  };
  const action = (type, v) => {
    h.actions.push([type, v]);
    if (h.bomb === `${type}:${v}`) {
      h.bomb = null;
      throw Error(`injected ${type}`);
    }
  };
  Object.assign(h, {
    upstream: () => h.disk,
    state: () => structuredClone(h.db),
    save: (s) => {
      h.db = structuredClone(s);
    },
    slot: (p) => h.apps[p],
    live: (p) => {
      a.ok(h.apps[p]);
      return h.apps[p];
    },
    prepare: () => action('prepare', 0),
    probe: (mode, p) => {
      action(mode, p);
      if (mode === 'ingress') a.equal(p, h.serving);
      else a.ok(h.apps[p]);
    },
    writeUpstream: (s) => {
      action('write', portOf(s));
      h.disk = s;
    },
    nginxTest: () => action('test', portOf(h.disk)),
    reload: () => {
      h.serving = portOf(h.disk);
      action('reload', h.serving);
    },
    start: (dir, p) => {
      action('start', p);
      h.apps[p] = app(dir, p);
    },
    waitCandidate: (dir, p) => a.equal(h.apps[p].cwd, dir),
    drained: () => !h.draining,
    cleanCandidate: (dir, p) => {
      a.notEqual(h.serving, p);
      if (h.apps[p]) a.equal(h.apps[p].cwd, dir);
      action('clean', p);
      delete h.apps[p];
    },
    removeRecorded: (x) => {
      a.notEqual(h.serving, x.port);
      a.deepEqual(h.apps[x.port], x);
      action('delete', x.port);
      delete h.apps[x.port];
    },
  });
  return h;
}
test('first cutover leaves original PID running; active-SHA retry revalidates without mutation', () => {
  const h = host(),
    prior = h.apps[8080];
  deploy(h, rel);
  a.equal(h.serving, 8081);
  a.equal(h.apps[8080], prior);
  a.deepEqual(h.db.previous, prior);
  h.actions = [];
  deploy(h, rel);
  a.deepEqual(
    h.actions.map((x) => x[0]),
    ['test', 'direct', 'ingress', 'prepare', 'ingress'],
  );
  a.equal(h.apps[8080], prior);
});
for (const bomb of ['direct:8081', 'test:8081', 'reload:8081', 'ingress:8081', 'write:8081'])
  test(`first attempt restores exact prior target on ${bomb}`, () => {
    const h = host(),
      prior = h.apps[8080];
    h.bomb = bomb;
    a.throws(() => deploy(h, rel), /injected/);
    a.equal(h.disk, old);
    a.equal(h.serving, 8080);
    a.equal(h.apps[8080], prior);
    a.equal(h.apps[8081], undefined);
    a.equal(h.db.pending, undefined);
  });
test('bad baseline and occupied, unknown or recently used inactive slot fail without removing anything', () => {
  const h = host();
  h.bomb = 'ingress:8080';
  a.throws(() => deploy(h, rel));
  a.ok(!h.actions.some((x) => x[0] === 'prepare'));
  h.apps[8081] = app('/unrelated', 8081);
  a.throws(() => deploy(h, rel), /unrecorded/);
  a.equal(h.serving, 8080);
  a.equal(h.apps[8081].cwd, '/unrelated');
  h.db.previous = { ...h.apps[8081] };
  h.draining = true;
  a.throws(() => deploy(h, rel), /not drained/);
  a.equal(h.apps[8081].cwd, '/unrelated');
});
test('third revision retires only a recorded and drained inactive PID; rollback reuses proven prior', () => {
  const h = host();
  deploy(h, rel);
  const second = rel + '2';
  deploy(h, second);
  a.equal(h.serving, 8080);
  a.deepEqual(
    h.actions.filter((x) => x[0] === 'delete'),
    [['delete', 8080]],
  );
  h.actions = [];
  deploy(h, rel);
  a.equal(h.serving, 8081);
  a.ok(!h.actions.some(([x]) => x === 'start' || x === 'delete'));
});
test('failed restoration leaves a durable journal, then a new invocation recovers before preparation', () => {
  const h = host(),
    probe = h.probe;
  let fail = true;
  h.probe = (mode, p) => {
    if (fail && mode === 'ingress' && (p === 8081 || h.apps[8081]))
      throw Error('probe unavailable');
    probe(mode, p);
  };
  a.throws(() => deploy(h, rel), /Rollback incomplete/);
  a.ok(h.db.pending);
  a.equal(h.disk, old);
  a.equal(h.serving, 8080);
  a.ok(h.apps[8081]);
  fail = false;
  h.actions = [];
  deploy(h, rel);
  a.equal(h.serving, 8081);
  a.equal(h.db.pending, undefined);
  a.ok(
    h.actions.findIndex((x) => x[0] === 'clean') < h.actions.findIndex((x) => x[0] === 'prepare'),
  );
});
test('only one identified listener and matching online API are accepted; worker/foreign/stopped entries refused', () => {
  const p = {
    name: 'mailhub-server-8081',
    pid: 345,
    pm_id: 3,
    pm2_env: {
      pm_cwd: rel,
      pm_exec_path: rel + '/dist/main.js',
      pm_uptime: 111,
      status: 'online',
      WORKER_MODE: 'false',
      PORT: 8081,
    },
  };
  const socket = 'LISTEN 0 511 *:8081 *:* users:(("node",pid=345,fd=22))\n';
  a.equal(selectSlot([p], socket, 8081).pid, 345);
  a.equal(selectSlot([], '', 8081), null);
  for (const [list, s] of [
    [[p], ''],
    [[p], socket.replace('345', '456')],
    [[{ ...p, name: 'mailhub-worker' }], socket],
    [[p], socket + 'LISTEN unknown'],
    [[p, p], socket],
    [[{ ...p, pm2_env: { ...p.pm2_env, WORKER_MODE: 'true' } }], socket],
  ])
    a.throws(() => selectSlot(list, s, 8081));
  a.throws(() => portOf(old + 'server 127.0.0.1:8081;'));
  a.throws(() => portOf('server foo:8080;'));
});
test('same SHA requires byte-, mode-, symlink-, extras- and dependency-identical clean installation', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-compare-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const [x, y] = ['clean', 'installed'].map((n) => path.join(tmp, n));
  for (const d of [x, y]) {
    fs.mkdirSync(d + '/node_modules/dep', { recursive: true });
    fs.writeFileSync(d + '/node_modules/dep/index.js', 'expected');
    fs.symlinkSync('/shared/.env', d + '/.env');
  }
  a.ok(equal(x, y));
  const dep = y + '/node_modules/dep/index.js';
  fs.writeFileSync(dep, 'tampered');
  a.equal(equal(x, y), false);
  fs.writeFileSync(dep, 'expected');
  fs.chmodSync(dep, 0o700);
  a.equal(equal(x, y), false);
  fs.chmodSync(dep, fs.statSync(x + '/node_modules/dep/index.js').mode & 0o777);
  fs.writeFileSync(y + '/extra', '');
  a.equal(equal(x, y), false);
  fs.unlinkSync(y + '/extra');
  fs.unlinkSync(y + '/.env');
  fs.symlinkSync('/elsewhere', y + '/.env');
  a.equal(equal(x, y), false);
});
test('bundle metadata rejects ambiguous digest paths, extra lines and revision symlinks', (t) => {
  const { revision } = require('../deploy/codedeploy/host.cjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'api-bundle-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const sha = 'a'.repeat(40),
    digest = '1'.repeat(64);
  fs.writeFileSync(d + '/backend.tar.gz', 'mock');
  fs.writeFileSync(d + '/revision.txt', sha + '\n');
  fs.writeFileSync(d + '/backend.tar.gz.sha256', digest + '  backend.tar.gz\n');
  a.deepEqual(revision(d), { sha, digest });
  for (const line of [digest + '  another-name\n', digest + '  backend.tar.gz\nsecond\n']) {
    fs.writeFileSync(d + '/backend.tar.gz.sha256', line);
    a.throws(() => revision(d));
  }
  fs.unlinkSync(d + '/revision.txt');
  fs.symlinkSync('backend.tar.gz', d + '/revision.txt');
  a.throws(() => revision(d), /type/);
});
