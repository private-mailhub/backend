'use strict';
// Keep Nest's design:paramtypes (tsc, not a decorator-stripping TS bundler). No new build dependencies.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const build = path.join(root, 'infra/worker/build');
const stage = path.join(build, 'staging');
const run = (cmd, args, cwd = root, extra = {}) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', ...extra });
  if (r.error || r.status !== 0) throw Error(`Worker packaging failed: ${cmd}`);
};
if (process.versions.node !== '24.14.1') throw Error('Build with Node 24.14.1');
fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'infra/worker/tsconfig.json']);
const files = fs
  .readdirSync(path.join(stage, 'src'), { recursive: true })
  .filter((x) => x.endsWith('.js'));
for (const file of files) {
  if (
    /(^|\/)(app\.module|queue-poller\.service|main|.*\.controller|.*\.spec|env\.validation|send-mail\.service)\.js$/.test(
      file,
    )
  )
    throw Error(`Unexpected API source: ${file}`);
  const filename = path.join(stage, 'src', file);
  const js = fs.readFileSync(filename, 'utf8').replace(/require\("(src\/[^"\n]+)"\)/g, (_, id) => {
    const relative = path
      .relative(path.dirname(filename), path.join(stage, id))
      .split(path.sep)
      .join('/');
    return `require(${JSON.stringify(relative.startsWith('.') ? relative : './' + relative)})`;
  });
  fs.writeFileSync(filename, js);
}
// Use only the exact production entries/integrities of the repository lock. No .env, dev dependencies, dist, tests or credentials.
for (const file of ['package.json', 'package-lock.json'])
  fs.copyFileSync(path.join(root, file), path.join(stage, file));
run(
  'npm',
  [
    'ci',
    '--omit=dev',
    '--no-bin-links',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--engine-strict',
    '--prefer-offline',
  ],
  stage,
);
for (const f of ['package-lock.json', 'package.json']) fs.rmSync(path.join(stage, f));
fs.rmSync(path.join(stage, 'node_modules/.bin'), { recursive: true, force: true });
// Smoke-test actual Node module resolution, with no source-tree fallback or required secrets at import time.
run(
  process.execPath,
  [
    '-e',
    `const M=require('node:module');const old=M._resolveFilename;M._resolveFilename=function(...a){const v=old.apply(this,a);if(v.startsWith('/')&&!v.startsWith(process.cwd()+'/'))throw Error('Outside bundle: '+v);return v};if(typeof require('./src/worker-lambda/handler.js').handler!=='function')process.exit(1);`,
  ],
  stage,
  { env: { PATH: process.env.PATH, AWS_EC2_METADATA_DISABLED: 'true' } },
);
let bytes = 0;
const epoch = new Date('2000-01-01T00:00:00.000Z');
const entries = fs.readdirSync(stage, { recursive: true }).sort();
const filesOnly = [];
for (const entry of entries) {
  const full = path.join(stage, entry);
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) throw Error('Unexpected symlink in package');
  if (stat.isFile()) {
    bytes += stat.size;
    fs.utimesSync(full, epoch, epoch);
    filesOnly.push(entry);
  }
}
if (bytes >= 250 * 1024 * 1024) throw Error('Package exceeds Lambda uncompressed size');
run('zip', ['-X', '-q', path.join(build, 'worker.zip'), '-@'], stage, {
  stdio: ['pipe', 'inherit', 'inherit'],
  input: filesOnly.join('\n') + '\n',
  env: { ...process.env, TZ: 'UTC' },
});
const digest = createHash('sha256')
  .update(fs.readFileSync(path.join(build, 'worker.zip')))
  .digest('hex');
console.log(`worker.zip: ${bytes} bytes unpacked; sha256 ${digest}`);
fs.writeFileSync(path.join(build, 'worker.sha256'), `${digest}  worker.zip\n`);
