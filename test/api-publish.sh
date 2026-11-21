#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd); temp=$(mktemp -d); trap 'rm -rf "$temp"' EXIT
mkdir -p "$temp/bin"; export PATH="$temp/bin:$PATH" MOCK_TRACE="$temp/trace" DEPLOY_BUCKET=test-bucket CODEDEPLOY_APP=api-test CODEDEPLOY_GROUP=local-api GITHUB_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa GITHUB_RUN_ID=431 GITHUB_RUN_ATTEMPT=2
printf 'test artifact' > "$temp/api.zip"
cat > "$temp/bin/aws" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "$1" "$2" >> "$MOCK_TRACE"
case "$1:$2" in
  s3api:get-bucket-versioning) printf '%s\n' "${MOCK_VERSIONING:-Enabled}" ;;
  s3api:put-object) [[ "$*" == *"--key api/$GITHUB_SHA/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.zip"* && "$*" == *'--if-none-match *'* ]]; printf '%s\n' "${MOCK_VERSION:-test.version}" ;;
  deploy:create-deployment)
    while [[ $# -gt 0 && $1 != --revision ]]; do shift; done
    jq -e --arg bucket "$DEPLOY_BUCKET" --arg key "api/$GITHUB_SHA/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.zip" '.revisionType=="S3" and .s3Location=={bucket:$bucket,key:$key,bundleType:"zip",version:"test.version"}' <<< "$2" >/dev/null
    printf 'd-ABC123\n' ;;
  deploy:wait) [[ $3 == deployment-successful && $5 == d-ABC123 ]]; exit "${MOCK_WAIT:-0}" ;;
  *) exit 12 ;;
esac
MOCK
chmod +x "$temp/bin/aws"
run() { : > "$MOCK_TRACE"; bash "$root/deploy/publish-api.sh" "$temp/api.zip"; }
run; [[ $(wc -l < "$MOCK_TRACE") -eq 4 ]]
if MOCK_VERSIONING=Suspended run; then exit 1; fi; [[ $(wc -l < "$MOCK_TRACE") -eq 1 ]]
if MOCK_VERSION=None run; then exit 1; fi; [[ $(wc -l < "$MOCK_TRACE") -eq 2 ]]
if MOCK_WAIT=4 run; then exit 1; fi
# Build a tiny committed fixture; local settings and untracked hook files must not ship.
r="$temp/fixture"; mkdir -p "$r/deploy/codedeploy" "$r/dist"; cp "$root/deploy/package-api.sh" "$r/deploy/"
for f in .nvmrc package.json package-lock.json appspec.yml deploy/release.sh deploy/ecosystem.config.cjs deploy/codedeploy/activate.sh; do printf 'fixture\n' > "$r/$f"; done
(cd "$r"; git init -q; git add .; git -c user.name=fixture -c user.email=test@example.invalid -c commit.gpgsign=false commit -qm fixture)
sha=$(git -C "$r" rev-parse HEAD); echo 'module.exports = 1;' > "$r/dist/main.js"; echo omit > "$r/.env"; echo omit > "$r/deploy/codedeploy/local-only"
(cd "$r"; bash deploy/package-api.sh "$sha" "$temp/first.zip"; touch dist/main.js; bash deploy/package-api.sh "$sha" "$temp/second.zip")
cmp "$temp/first.zip" "$temp/second.zip"; mkdir "$temp/unpacked"; unzip -qo "$temp/first.zip" -d "$temp/unpacked"; [[ $(cat "$temp/unpacked/revision.txt") == "$sha" ]]; [[ ! -e "$temp/unpacked/deploy/codedeploy/local-only" ]]; (cd "$temp/unpacked"; shasum -a 256 -c backend.tar.gz.sha256; tar -tzf backend.tar.gz > "$temp/list"); grep -qx 'dist/main.js' "$temp/list"; if grep -Eq '(^|/)(\.env|node_modules|\.git)(/|$)' "$temp/list"; then exit 1; fi
if grep -Eq 'EC2_SSH_KEY|authorize-security-group-ingress|scp |ssh ' "$root/.github/workflows/deploy-api.yml"; then echo 'Unexpected SSH configuration' >&2; exit 1; fi
printf 'PASS: deterministic allowlisted package, version-pinned S3 publish, guard conditions and CodeDeploy failure propagation\n'
