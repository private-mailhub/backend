# Independent deployment and rollback

## Activation gates

Deployment workflows are manual and gated by the repository-level Actions variable
`DEPLOYMENT_ENABLED=true`. Leave it unset until the following checks are complete.
This PR prepares deployment; it does not claim a completed production migration.

1. Read the actual EC2 Node/npm versions, PM2 process names/CWD/script/uptime, Nginx configuration,
   active ports, free memory, and current artifact hashes. Record them outside Git without secrets.
   Node 24.14.1 is the validation runtime; verify compatibility on EC2 before activating deployment.
   Verify the non-interactive SSH deploy user also resolves this Node/npm version in PATH;
   an interactive NVM shell alone does not establish that.
2. Preserve `/var/www/private-mailhub`, its built assets, environment supply, and original worker.
   Confirm DB backup recovery is available. Do not initialize DB, run migrations, flush Redis, or rotate keys.
3. Freeze the old integrated workflow and production merges during cutover. Do not run it alongside
   the split workflows. Reconcile commits since the extraction snapshot first.
4. Provision Bash, tar, Python 3, Node/npm and util-linux `flock` on EC2.
   Provision both release/shared directories and a common `/var/lock/mailhub-deploy.lock` writable
   by the deploy user. Both repositories must use the same lock. Restrict deploy account permissions.
5. Provision the backend shared `.env` outside Git/artifacts. Match original keys, DB, Redis, AWS,
   Mailgun and CORS settings. CWD-based loading requires each release `.env` symlink. Worker also
   needs all shared validation values including PORT. Keep VITE_* build settings only in FE.
6. Configure each repository's production environment, approval protections, SSH host/user/port,
   known-hosts pin, security group, and AWS role. Scope frontend OIDC trust to its own repository
   and production environment. Do not duplicate backend runtime secrets into frontend Actions.
   Match the temporary ingress port to the SSH port; verify least privilege with the IAM owner.
   For backend `EC2_KNOWN_HOSTS`, pin `host` for port 22 and `[host]:port` for other ports,
   using the exact `EC2_HOST` value and the canonical decimal port without leading zeros.
   Hashed entries for the same endpoint are also supported.
7. Supply FE `VITE_API_URL` and existing `VITE_ENCRYPTION_KEY`. Never widen Vite envPrefix.
8. Validate mixed client/API versions in an isolated environment and the browser scenarios below.

Exact workflow secret names and inputs are listed in each `.github/workflows/deploy.yml`.
The backend workflow **prepares** an immutable release; API/worker activation is a separate manual
operation because authenticated readiness and the original production setup must be observed.
No deploy command builds inside a serving directory.

## Initial frontend transition

Run the frontend deploy workflow at the selected branch/SHA. It validates and builds frontend only,
publishes `/var/www/mailhub-frontend/releases/<sha>`, copies assets additively to `shared/assets/`,
and atomically switches `current`. Record the previous current target first. It never invokes PM2.

Before initially installing the backend-owned `deploy/nginx.conf`, copy the **existing production**
`front-end/dist/assets/` into the new shared asset directory without deleting existing hashes.
This keeps previously open browser tabs working. Also populate the first new FE release before
pointing Nginx at it. Keep the old checkout available for rollback.

Create `/etc/nginx/mailhub-backend-upstream.conf` with the observed current API endpoint (8080
in the template, but verify it), for example:

```nginx
server 127.0.0.1:8080 max_fails=3 fail_timeout=30s;
```

Back up the effective Nginx site and upstream files. Compare the template with the effective
configuration, preserving TLS, domains, proxy address/header chain and any operational overrides.
Under the common flock, install the reviewed site, run `sudo nginx -t`, and only then reload.
On test failure, restore the configuration before releasing the lock. HTTP and HTTPS both use
the same upstream and FE root. Check static files, `/assets/`, index.html, public files, and SPA fallback.

## API candidate, switch, then worker

Hold a single interactive shell lock throughout each transition (including rollback on failure):

```bash
exec 9>/var/lock/mailhub-deploy.lock
flock -x 9
```

1. Run the backend prepare workflow for the exact release SHA. Confirm its manifest, `.env` symlink,
   installed runtime dependencies and `dist/main.js` exist. Record old API/worker CWDs and ports.
2. Inspect listeners (`ss -ltnp`) and PM2. Choose the idle port from 8080/8081. Export
   `MAILHUB_RELEASE=/var/www/mailhub-backend/releases/<sha>` and `API_PORT=<idle-port>`.
   If that candidate name still exists as a stopped entry from an older release, record its
   config and delete only that stopped entry after confirming it is not the active upstream.
   Start only that candidate, then verify its PM2 CWD/script match the selected release:

   ```bash
   pm2 start "$MAILHUB_RELEASE/deploy/ecosystem.config.cjs" --only "mailhub-server-$API_PORT"
   ```

3. Check candidate logs and unauthenticated `/api/users/me` (401 expected), then use a managed test
   account to validate actual login, DB reads, Redis session refresh and credentialed CORS.
   **A 401 alone does not prove readiness.** Do not print tokens or real account details to logs.
4. Back up the active upstream file. Write the candidate port to a temporary file in `/etc/nginx/`
   and atomically replace `mailhub-backend-upstream.conf`. Run `sudo nginx -t`; restore the old
   file if it fails. Reload only after success. On reload/public checks failure restore the old
   upstream, test, and reload. Keep the old API available throughout.
5. Verify public web/API, existing-session refresh and proxy fingerprint compatibility. Wait for
   existing requests/connections to drain before stopping only the recorded old API process name.
   During initial cutover this may be `mailhub-server`; later it is `mailhub-server-8080` or `-8081`.
6. Replace the worker **last**. Verify there is exactly one existing consumer and no unexpected
   worker on another host. Record its release/config. Stop and delete only `mailhub-worker`, then:

   ```bash
   pm2 start "$MAILHUB_RELEASE/deploy/ecosystem.config.cjs" --only mailhub-worker
   ```

   If the new worker fails, stop/delete it and start the recorded previous worker with its original
   config and environment. Never restart all PM2 applications. Persist PM2 state only after success.
7. Check SQS backlog, processing errors, mail delivery and reply masking with a controlled message.
   Release the lock after verification. There is no worker drain or deduplication guarantee:
   replacement can briefly delay mail and a send-before-delete interruption can cause redelivery.

## Independent rollback

Hold the same server lock and record exact current/previous release identities.

- **FE:** create a temporary symlink beside `current` to the recorded previous release, then
  `mv -Tf` it over `current`. Keep shared hash assets. On first migration the Nginx site backup
  can restore the original checkout if necessary. API/worker processes remain unchanged.
- **API:** start/verify the previous API at its recorded port if it was stopped. Restore upstream,
  run `nginx -t`, reload, verify public and session checks, then stop the failed candidate only.
- **Worker:** stop/delete the failed worker and start the recorded previous release's worker alone.
  Verify a single consumer and delivery. Do not restart the healthy API.

No DB reverse migration, Redis flush, or key regeneration belongs to separation rollback.
Keep previous artifacts, refs, and backups until the rollback window has been explicitly closed.

## Acceptance record

For each deployment record SHA, release paths, previous targets, Node/npm versions, PM2 names/ports,
Nginx site/upstream paths, timestamps and validation outcomes in the operational change record.
Do not commit secrets, token-bearing responses or personal data.

Verify old FE/new BE, new FE/old BE and new/new; existing login refresh/cookie rotation/logout;
email verification; GitHub/Google login/link/revoke; callback error/deep-link reload; relay CRUD;
profile/admin views; stale tabs/assets/new tabs/back navigation; controlled mail/reply masking/SQS.
Frontend-only deployment must preserve API/worker PID and uptime. Backend-only deployment must
preserve FE current and file hashes. Repeat public, session and mail checks after each rollback.
Only then unfreeze production automation and mark the operational split complete.
