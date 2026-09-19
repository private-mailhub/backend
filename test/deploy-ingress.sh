#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
workflow="$repo_root/.github/workflows/deploy.yml"
block=$(awk '
  /- name: Authorize temporary runner ingress/ {seen=1}
  seen && /        run: \|/ {running=1; next}
  running && /^      - name:/ {exit}
  running {sub(/^          /, ""); print}
' "$workflow")

cleanup=$(awk '
  /- name: Revoke temporary runner ingress/ {seen=1}
  seen && /        run: \|/ {running=1; next}
  running {sub(/^          /, ""); print}
' "$workflow")

grep -q 'describe-security-group-rules' <<<"$block" || {
  printf 'FAIL: ingress setup must look up an existing matching rule\n' >&2
  exit 1
}
grep -q 'existing_rule' <<<"$block" || {
  printf 'FAIL: ingress setup must branch on the existing rule\n' >&2
  exit 1
}
grep -q 'authorize-security-group-ingress' <<<"$block" || {
  printf 'FAIL: ingress setup must authorize only when no matching rule exists\n' >&2
  exit 1
}
grep -q 'ingress_added=true' <<<"$block" || {
  printf 'FAIL: ingress setup must record whether it created the rule\n' >&2
  exit 1
}
grep -q 'if.*ingress_added.*true' <<<"$cleanup" || {
  printf 'FAIL: cleanup must revoke only a rule created by this run\n' >&2
  exit 1
}
grep -q 'revoke-security-group-ingress' <<<"$cleanup" || {
  printf 'FAIL: cleanup must revoke newly created ingress\n' >&2
  exit 1
}

printf 'PASS: deployment reuses existing runner ingress and revokes only newly created rules\n'
