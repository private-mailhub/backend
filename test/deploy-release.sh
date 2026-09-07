#!/usr/bin/env bash
set -eu

repo_root=$(cd "$(dirname "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

deploy_root="$test_root/backend"
archive_root="$test_root/archive"
stub_bin="$test_root/bin"
mkdir -p "$deploy_root/shared" "$archive_root/dist" "$stub_bin" "$archive_root/deploy"
printf 'DATABASE_URL=test\n' > "$deploy_root/shared/.env"
printf 'module.exports = {};\n' > "$archive_root/dist/main.js"
printf '{"name":"mailhub-backend","version":"test"}\n' > "$archive_root/package.json"
printf '{"name":"mailhub-backend","lockfileVersion":3,"packages":{}}\n' > "$archive_root/package-lock.json"
printf '24.14.1\n' > "$archive_root/.nvmrc"
printf "module.exports = { apps: [] };\n" > "$archive_root/deploy/ecosystem.config.cjs"
tar -czf "$test_root/backend.tar.gz" -C "$archive_root" dist package.json package-lock.json .nvmrc deploy/ecosystem.config.cjs

cat > "$stub_bin/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${MAILHUB_TEST_NPM_LOG:?}"
case " $* " in
  *' --ignore-scripts '*) ;;
  *) printf 'npm install did not disable lifecycle scripts\n' >&2; exit 43 ;;
esac
if [ -e .env ]; then
  printf 'shared .env was exposed during npm install\n' >&2
  exit 44
fi
if [ "${MAILHUB_TEST_NPM_FAIL:-0}" = 1 ]; then
  exit 42
fi
exit 0
EOF
cat > "$stub_bin/pm2" <<'EOF'
#!/usr/bin/env bash
printf 'pm2 must not be called\n' >&2
exit 99
EOF
if ! command -v flock >/dev/null 2>&1; then
cat > "$stub_bin/flock" <<'EOF'
#!/usr/bin/env python3
import fcntl
import os
import subprocess
import sys

args = sys.argv[1:]
while args and args[0] in ('-x', '-n', '-w'):
    args.pop(0)
if args and args[0].isdigit():
    fcntl.flock(int(args[0]), fcntl.LOCK_EX)
    raise SystemExit(0)
if len(args) >= 3 and args[1] == '-c':
    with open(args[0], 'a+') as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        raise SystemExit(subprocess.call(['/bin/sh', '-c', args[2]]))
raise SystemExit('test flock shim supports flock [-x|-n] FD or flock LOCK_PATH -c COMMAND')
EOF
fi
chmod +x "$stub_bin/npm" "$stub_bin/pm2"
if [ -e "$stub_bin/flock" ]; then
  chmod +x "$stub_bin/flock"
fi
export MAILHUB_TEST_NPM_LOG="$test_root/npm.log"
export PATH="$stub_bin:$PATH"
export MAILHUB_DEPLOY_ROOT="$deploy_root"
export MAILHUB_DEPLOY_LOCK="$test_root/deploy.lock"

sha=0123456789abcdef0123456789abcdef01234567
script="$repo_root/deploy/release.sh"
if [ ! -x "$script" ]; then
  printf 'FAIL: expected executable %s\n' "$script" >&2
  exit 1
fi

if ! "$script" "$sha" "$test_root/backend.tar.gz"; then
  printf 'FAIL: valid backend release was not prepared\n' >&2
  exit 1
fi

release="$deploy_root/releases/$sha"
[ -f "$release/dist/main.js" ] || { printf 'FAIL: dist/main.js missing\n' >&2; exit 1; }
[ -f "$release/.nvmrc" ] || { printf 'FAIL: .nvmrc missing\n' >&2; exit 1; }
[ -f "$release/deploy/ecosystem.config.cjs" ] || {
  printf 'FAIL: PM2 ecosystem config missing\n' >&2
  exit 1
}
[ -L "$release/.env" ] || { printf 'FAIL: .env is not a symlink\n' >&2; exit 1; }
[ "$(readlink "$release/.env")" = "$deploy_root/shared/.env" ] || {
  printf 'FAIL: .env points outside shared configuration\n' >&2
  exit 1
}

if "$script" "$sha" "$test_root/backend.tar.gz" >/dev/null 2>&1; then
  printf 'FAIL: existing release was overwritten on repeat\n' >&2
  exit 1
fi

if "$script" bad-sha "$test_root/backend.tar.gz" >/dev/null 2>&1; then
  printf 'FAIL: invalid SHA was accepted\n' >&2
  exit 1
fi

failed_sha=abcdefabcdefabcdefabcdefabcdefabcdefabcd
export MAILHUB_TEST_NPM_FAIL=1
if "$script" "$failed_sha" "$test_root/backend.tar.gz" >/dev/null 2>&1; then
  printf 'FAIL: npm failure was reported as a successful release\n' >&2
  exit 1
fi
[ ! -e "$deploy_root/releases/$failed_sha" ] || {
  printf 'FAIL: npm failure left an unpublished release\n' >&2
  exit 1
}

printf 'PASS: backend release preparation, immutable config link, npm isolation, and SHA validation\n'
