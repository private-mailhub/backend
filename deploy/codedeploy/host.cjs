'use strict';
// Linux CodeDeploy adapter. Only this root-owned coordinator can edit the one
// Nginx include and transaction journal. Never print PM2 JSON or probe output.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { deploy, apiName, same, isRelease, portOf } = require('./transaction.cjs');
const root = '/var/www/mailhub-backend',
  upstream = '/etc/nginx/mailhub-backend-upstream.conf';
const journal = '/var/lib/mailhub-api-deploy/state.json',
  helper = '/usr/local/libexec/mailhub-api-readiness';
const bundle = path.resolve(__dirname, '../..');
const assert = (v, m) => {
  if (!v) throw new Error(m);
};
function run(cmd, args, timeout = 30000) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(
    !r.error && !r.signal && r.status === 0,
    `Command failed: ${path.basename(cmd)} (${r.status ?? 'timeout/error'})`,
  );
  return r.stdout;
}
function trusted(p, type) {
  let q = p;
  while (true) {
    const s = fs.lstatSync(q);
    assert(
      s.uid === 0 &&
        !(s.mode & 0o022) &&
        (q === p && type === 'file' ? s.isFile() : s.isDirectory()),
      `Unsafe host path: ${q}`,
    );
    if (q === '/') break;
    q = path.dirname(q);
  }
}
function atomic(file, text, mode) {
  const tmp = path.join(path.dirname(file), `.mailhub-${randomUUID()}`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeFileSync(fd, text);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
    const d = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
function revision(dir = bundle) {
  for (const n of ['revision.txt', 'backend.tar.gz', 'backend.tar.gz.sha256'])
    assert(fs.lstatSync(path.join(dir, n)).isFile(), 'Invalid bundle file type');
  const sha = fs.readFileSync(path.join(dir, 'revision.txt'), 'utf8').match(/^([\da-f]{40})\n?$/i);
  const digest = fs
    .readFileSync(path.join(dir, 'backend.tar.gz.sha256'), 'utf8')
    .match(/^([a-f0-9]{64}) [ *]backend\.tar\.gz\n?$/i);
  assert(sha && digest, 'Invalid revision or canonical checksum line');
  return { sha: sha[1].toLowerCase(), digest: digest[1].toLowerCase() };
}
function identity(p, port) {
  const e = p.pm2_env || {};
  return {
    name: p.name,
    id: p.pm_id,
    pid: p.pid,
    since: e.pm_uptime,
    cwd: e.pm_cwd,
    script: e.pm_exec_path,
    port,
    apiMode: e.WORKER_MODE === 'false' && String(e.PORT) === String(port),
    status: e.status,
    worker: e.WORKER_MODE === 'true',
  };
}
function selectSlot(list, socket, port) {
  const ids = [...new Set(Array.from(socket.matchAll(/\bpid=(\d+)/g), (m) => Number(m[1])))];
  const named = list.filter((p) => p.name === apiName(port));
  if (!socket.trim() && !named.length) return null;
  assert(
    ids.length === 1 &&
      socket
        .trim()
        .split('\n')
        .every((l) => l.includes(`pid=${ids[0]},`)),
    'Occupied or unidentified listener',
  );
  const byPid = list.filter((p) => p.pid === ids[0]);
  assert(
    byPid.length === 1 && named.length <= 1 && (!named.length || named[0] === byPid[0]),
    'PM2 and listener disagree',
  );
  const a = identity(byPid[0], port);
  assert(
    (a.name === 'mailhub-server' || (a.name === apiName(port) && a.apiMode)) &&
      !a.worker &&
      a.status === 'online' &&
      Number.isInteger(a.id) &&
      a.id >= 0 &&
      a.pid > 1 &&
      a.since > 0 &&
      path.isAbsolute(a.cwd) &&
      path.isAbsolute(a.script),
    'Not the expected online API',
  );
  return a;
}
function main() {
  assert(process.getuid() === 0, 'Root CodeDeploy launcher required');
  const cfg = '/etc/mailhub/api-codedeploy.json';
  trusted(cfg, 'file');
  trusted(helper, 'file');
  fs.accessSync(helper, fs.constants.X_OK);
  trusted(upstream, 'file');
  trusted(path.dirname(journal), 'dir');
  const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert(
    /^[a-z_][a-z0-9_-]*$/.test(c.serviceUser) && c.serviceUser !== 'root',
    'Configure a non-root service account',
  );
  const acct = run('/usr/bin/getent', ['passwd', c.serviceUser]).trim().split(':');
  const uid = Number(acct[2]),
    home = acct[5];
  assert(
    acct[0] === c.serviceUser && Number.isInteger(uid) && uid > 0 && path.isAbsolute(home),
    'Invalid service identity',
  );
  for (const p of [c.nodeBin, c.pm2Home])
    assert(
      typeof p === 'string' &&
        /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(p) &&
        path.resolve(p) === p,
      'Invalid service runtime path',
    );
  const env = [
    '-i',
    `HOME=${home}`,
    `USER=${c.serviceUser}`,
    `LOGNAME=${c.serviceUser}`,
    `PATH=${c.nodeBin}:/usr/local/bin:/usr/bin:/bin`,
    `PM2_HOME=${c.pm2Home}`,
  ];
  const svc = (args, extra = [], timeout) =>
    run(
      '/usr/sbin/runuser',
      ['-u', c.serviceUser, '--', '/usr/bin/env', ...env, ...extra, ...args],
      timeout,
    );
  function daemon() {
    const sock = fs.lstatSync(path.join(c.pm2Home, 'rpc.sock'));
    const pid = fs.readFileSync(path.join(c.pm2Home, 'pm2.pid'), 'utf8').trim();
    assert(
      sock.isSocket() &&
        sock.uid === uid &&
        /^[1-9]\d+$/.test(pid) &&
        fs.statSync(`/proc/${pid}`).uid === uid,
      'Existing service-user PM2 daemon required',
    );
  }
  const pm = (args, vars = []) => {
    daemon();
    return svc(['pm2', ...args], vars);
  };
  const list = () => {
    const raw = pm(['jlist']);
    try {
      const parsed = JSON.parse(raw);
      assert(Array.isArray(parsed), 'Invalid PM2 inventory');
      return parsed;
    } catch {
      throw new Error('Unable to read service-user PM2 inventory');
    }
  };
  const socket = (port) => run('/usr/bin/ss', ['-H', '-ltnp', `sport = :${port}`]);
  const slot = (port) => selectSlot(list(), socket(port), port);
  const live = (port) => {
    const a = slot(port);
    assert(a, 'Expected live API is missing');
    return a;
  };
  const probe = (mode, port) => {
    const result = svc([helper, mode, String(port)], [], 65000);
    assert(
      result === `READY ${mode} ${port}\n`,
      `Authenticated readiness did not attest ${mode} ${port}`,
    );
  };
  const { sha, digest } = revision();
  const release = `${root}/releases/${sha}`;
  const scratch = fs.mkdtempSync('/var/tmp/mailhub-api-');
  try {
    // Agent revision directories may be 0700. Pass a non-writable, readable copy
    // to the service account instead of weakening the agent's permissions.
    for (const [from, to] of [
      ['backend.tar.gz', 'backend.tar.gz'],
      ['deploy/release.sh', 'release.sh'],
      ['deploy/codedeploy/compare-tree.cjs', 'compare-tree.cjs'],
    ]) {
      const dest = path.join(scratch, to);
      fs.copyFileSync(path.join(bundle, from), dest);
      fs.chmodSync(dest, 0o444);
    }
    const tar = path.join(scratch, 'backend.tar.gz');
    assert(
      createHash('sha256').update(fs.readFileSync(tar)).digest('hex') === digest,
      'Backend archive checksum mismatch',
    );
    fs.chmodSync(scratch, 0o711);
    const nginxTest = () => run('/usr/sbin/nginx', ['-t']);
    const read = () => fs.readFileSync(upstream, 'utf8');
    const ops = {
      state: () => {
        try {
          trusted(journal, 'file');
          return JSON.parse(fs.readFileSync(journal, 'utf8'));
        } catch (e) {
          if (e.code === 'ENOENT') return {};
          throw e;
        }
      },
      save: (s) => atomic(journal, JSON.stringify(s) + '\n', 0o600),
      upstream: read,
      writeUpstream: (text) => atomic(upstream, text, fs.statSync(upstream).mode & 0o777),
      nginxTest,
      reload: () => run('/usr/bin/systemctl', ['reload', 'nginx']),
      probe,
      live,
      slot,
      prepare: () =>
        svc(
          [
            '/bin/bash',
            '-c',
            'set -eu; umask 022; source "$1/release.sh"; prepare_backend_release "$2" "$1/backend.tar.gz" "$1/compare-tree.cjs"',
            'mailhub',
            scratch,
            sha,
          ],
          [],
          480000,
        ),
      start: (dir, port) =>
        pm(
          ['start', `${dir}/deploy/ecosystem.config.cjs`, '--only', apiName(port)],
          [`MAILHUB_RELEASE=${dir}`, `API_PORT=${port}`],
        ),
      waitCandidate: (dir, port) => {
        for (let i = 0; i < 30; i++) {
          try {
            if (isRelease(live(port), dir, port)) return;
          } catch {
            /* starting */
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        }
        throw new Error('Candidate did not bind the expected port with its own PM2 PID');
      },
      drained: (port, t) =>
        Number.isFinite(t) &&
        Date.now() - t >= 120000 &&
        !run('/usr/bin/ss', ['-Htn', 'state', 'established', `sport = :${port}`]).trim(),
      removeRecorded: (a) => {
        assert(
          portOf(read()) !== a.port && same(a, live(a.port)),
          'Refusing to touch changed/active PM2 process',
        );
        pm(['delete', String(a.id)]);
      },
      cleanCandidate: (dir, port) => {
        assert(portOf(read()) !== port, 'Cannot clean active API');
        const entries = list().filter((p) => p.name === apiName(port));
        if (!entries.length) return;
        assert(entries.length === 1, 'Ambiguous candidate PM2 entries');
        const a = identity(entries[0], port);
        assert(
          isRelease(a, dir, port) && Number.isInteger(a.id) && a.id >= 0,
          'Cannot identify failed candidate',
        );
        const sock = socket(port);
        if (sock.trim())
          assert(
            same(selectSlot([entries[0]], sock, port), a),
            'Candidate listener identity mismatch',
          );
        pm(['delete', String(a.id)]);
      },
    };
    deploy(ops, release);
    console.log(`API deployment verified: ${sha}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`API deployment failed: ${e.message}`);
    process.exitCode = 1;
  }
}
module.exports = { selectSlot, identity, revision };
