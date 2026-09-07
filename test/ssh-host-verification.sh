#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

fragment="$test_root/prepare-pinned-host.sh"
awk '
  /- name: Prepare pinned SSH host verification/ { seen=1 }
  seen && /        run: \|/ { running=1; next }
  running && /^      - name:/ { exit }
  running { sub(/^          /, ""); print }
' "$repo_root/.github/workflows/deploy.yml" > "$fragment"

if [ ! -s "$fragment" ] || ! grep -q 'ssh-keygen' "$fragment" || ! bash -n "$fragment"; then
  printf 'FAIL: could not extract a valid pinned SSH host verification block\n' >&2
  exit 1
fi

ssh-keygen -q -t ed25519 -N '' -f "$test_root/client-key"
ssh-keygen -q -t ed25519 -N '' -f "$test_root/host-key"
host_public_key=$(ssh-keygen -y -f "$test_root/host-key")
host_name='mailhub-test.local'
plain_known_hosts="$host_name $host_public_key"
bracketed_known_hosts="[$host_name]:2222 $host_public_key"
bracketed_8080_known_hosts="[$host_name]:8080 $host_public_key"
printf '%s\n' "$bracketed_known_hosts" > "$test_root/hashed-known-hosts"
ssh-keygen -q -H -f "$test_root/hashed-known-hosts"
hashed_known_hosts=$(sed -n '1p' "$test_root/hashed-known-hosts")

run_case() {
  local name=$1
  local port=$2
  local known_hosts=$3
  local expected_status=$4
  local case_root="$test_root/$name"
  local status

  mkdir -p "$case_root"
  export EC2_HOST="$host_name"
  export EC2_PORT="$port"
  export EC2_SSH_KEY
  EC2_SSH_KEY=$(<"$test_root/client-key")
  export EC2_KNOWN_HOSTS="$known_hosts"
  export RUNNER_TEMP="$case_root"
  export GITHUB_OUTPUT="$case_root/github-output"
  export GITHUB_ENV="$case_root/github-env"

  set +e
  bash "$fragment" >/dev/null 2>&1
  status=$?
  set -e

  if [ "$status" -ne "$expected_status" ]; then
    printf 'FAIL: %s expected status %s, got %s\n' "$name" "$expected_status" "$status" >&2
    exit 1
  fi
  printf 'PASS: %s\n' "$name"
}

run_case 'port-22-plain-entry' 22 "$plain_known_hosts" 0
run_case 'padded-port-022-plain-entry' 022 "$plain_known_hosts" 0
run_case 'port-22-bracketed-entry-rejected' 22 "[$host_name]:22 $host_public_key" 1
run_case 'port-2222-bracketed-entry' 2222 "$bracketed_known_hosts" 0
run_case 'padded-port-02222-bracketed-entry' 02222 "$bracketed_known_hosts" 0
run_case 'padded-port-08080-bracketed-entry' 08080 "$bracketed_8080_known_hosts" 0
run_case 'port-2222-plain-entry-rejected' 2222 "$plain_known_hosts" 1
run_case 'port-2222-wrong-port-rejected' 2222 "[$host_name]:2200 $host_public_key" 1
run_case 'port-2222-hashed-entry' 2222 "$hashed_known_hosts" 0
run_case 'port-65536-rejected' 65536 "$bracketed_known_hosts" 1
