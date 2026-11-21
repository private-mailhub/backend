#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
here=$(cd -- "$(dirname -- "$0")" && pwd -P)
lock=/var/lock/mailhub-deploy.lock
[[ $EUID -eq 0 && -f $lock && ! -L $lock ]] || { echo 'Missing provisioned lock or wrong hook user' >&2; exit 1; }
# The flock supervisor holds the fd; npm, PM2 and the service never inherit it.
exec /usr/bin/flock --exclusive --wait 120 --close "$lock" /usr/bin/env -i PATH="$PATH" HOME=/root /usr/bin/node "$here/host.cjs"
