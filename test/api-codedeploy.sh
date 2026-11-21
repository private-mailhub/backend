#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash -n deploy/release.sh
bash -n deploy/codedeploy/api.sh
test -x deploy/codedeploy/api.sh
node --test test/api-codedeploy.cjs
# Exercise the sourced, already-locked prepare path with real tar, file comparison
# and npm stub. Using a flock stub that always fails catches nested lock acquisition.
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/bin" "$t/backend/shared" "$t/source/dist" "$t/source/deploy"
printf 'TEST_ONLY=true\n' > "$t/backend/shared/.env"
printf 'source\n' > "$t/source/dist/main.js"
printf '{}\n' > "$t/source/package.json"; cp "$t/source/package.json" "$t/source/package-lock.json"
cp .nvmrc "$t/source/.nvmrc"; cp deploy/ecosystem.config.cjs "$t/source/deploy/"
tar -czf "$t/backend.tar.gz" -C "$t/source" dist package.json package-lock.json deploy .nvmrc
cat > "$t/bin/npm" <<'MOCK'
#!/bin/bash
set -eu
[[ "$*" == 'ci --omit=dev --engine-strict --ignore-scripts' && ! -e .env ]]
mkdir -p node_modules/example; printf 'installed' > node_modules/example/index.js
MOCK
printf '#!/bin/bash\nexit 77\n' > "$t/bin/flock"; chmod +x "$t/bin/npm" "$t/bin/flock"
export PATH="$t/bin:$PATH" MAILHUB_DEPLOY_ROOT="$t/backend" MAILHUB_DEPLOY_LOCK="$t/lock"
sha=0123456789abcdef0123456789abcdef01234567
strict_prepare() { bash -c 'source deploy/release.sh; prepare_backend_release "$@"' mailhub "$sha" "$t/backend.tar.gz" "$PWD/deploy/codedeploy/compare-tree.cjs"; }
strict_prepare; strict_prepare
dep="$t/backend/releases/$sha/node_modules/example/index.js"; printf tampered > "$dep"
if strict_prepare >/dev/null 2>&1; then echo 'accepted tampered installed file' >&2; exit 1; fi
[[ $(cat "$dep") == tampered && -z $(find "$t/backend/releases" -name '.*.tmp.*' -print -quit) ]]
echo 'PASS: clean CodeDeploy retry, no nested flock, installed-file tamper refusal without overwrite'
