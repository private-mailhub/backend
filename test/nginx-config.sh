#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
config="$repo_root/deploy/nginx.conf"
http_server=$(sed -n '1,/^# HTTPS server/p' "$config")
https_server=$(sed -n '/^# HTTPS server/,$p' "$config")

if [[ -z "$http_server" || -z "$https_server" ]]; then
  printf 'FAIL: expected separate HTTP and HTTPS server blocks\n' >&2
  exit 1
fi

grep -q 'listen 80;' <<<"$http_server" || {
  printf 'FAIL: HTTP server block is missing port 80\n' >&2
  exit 1
}
grep -q 'location /.well-known/acme-challenge/' <<<"$http_server" || {
  printf 'FAIL: HTTP server block must keep ACME challenge support\n' >&2
  exit 1
}
grep -q 'return 308 https://private-mailhub.com\$request_uri;' <<<"$http_server" || {
  printf 'FAIL: HTTP server block must redirect non-ACME requests to HTTPS with 308\n' >&2
  exit 1
}
if grep -qE 'proxy_pass|location \^~ /api|root /var/www/mailhub-frontend/current' <<<"$http_server"; then
  printf 'FAIL: HTTP server block serves application content instead of only ACME and redirect\n' >&2
  exit 1
fi

grep -q 'listen 443 ssl' <<<"$https_server" || {
  printf 'FAIL: HTTPS server block is missing TLS listener\n' >&2
  exit 1
}
grep -q 'Strict-Transport-Security' <<<"$https_server" || {
  printf 'FAIL: HTTPS server block is missing HSTS\n' >&2
  exit 1
}
hsts_count=$(grep -c 'Strict-Transport-Security' <<<"$https_server")
if (( hsts_count < 5 )); then
  printf 'FAIL: locations with cache headers must repeat HSTS because Nginx does not inherit add_header values there\n' >&2
  exit 1
fi

printf 'PASS: HTTP is ACME-only with 308 redirect and HTTPS sends HSTS\n'
