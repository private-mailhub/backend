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
   needs all shared validation values including PORT. Keep client-web build settings out of the
   backend environment; the API only needs its server-side settings.
6. Configure the `backend-api` and `client-web` production environments with required reviewers,
   main-branch/tag restrictions, SSH host/user/port, known-hosts pin, security group, and AWS role.
   Scope each repository's OIDC trust to that repository and its `production` environment. Do not
   duplicate backend runtime secrets into client-web Actions. Keep `DEPLOYMENT_ENABLED` unset until
   the environment protections and OIDC subject conditions have been reviewed by the IAM owner.
   Match the temporary ingress port to the SSH port; verify least privilege with the IAM owner.
   For backend `EC2_KNOWN_HOSTS`, pin `host` for port 22 and `[host]:port` for other ports,
   using the exact `EC2_HOST` value and the canonical decimal port without leading zeros.
   Hashed entries for the same endpoint are also supported.
7. Supply client-web `VITE_API_URL` only. Do not supply `ENCRYPTION_KEY` or
   `VITE_ENCRYPTION_KEY`; Vite embeds `VITE_*` values in the browser bundle.
8. Validate mixed client/API versions in an isolated environment and the browser scenarios below.

## Staged encryption-key rotation

The API reads `ENCRYPTION_KEY` first and optionally tries the comma-separated
`LEGACY_ENCRYPTION_KEYS` values for existing ciphertext. New writes always use `ENCRYPTION_KEY`.
Rotate keys in this order, with a backup and a disposable-environment rehearsal before production:

1. Configure the current production key as the first legacy value and deploy a release that supports
   the fallback. Do not remove the old key while records still depend on it.
2. Generate a new random 32-byte Base64 key and set it as `ENCRYPTION_KEY`. Keep the prior key in
   `LEGACY_ENCRYPTION_KEYS`; deploy the API and verify old reads plus new login/profile/relay writes.
3. Rewrite encrypted records through an authenticated, auditable maintenance operation that reads
   with fallback and writes with the current key. This repository does not run that operation or
   modify database migrations during repository separation.
4. Confirm that the old key is no longer needed, remove it from `LEGACY_ENCRYPTION_KEYS`, and retain
   the change record and rollback material for the agreed retention window. Never place any key in
   client-web build settings.

Exact workflow secret names and inputs are listed in each `.github/workflows/deploy.yml`.
The backend workflow **prepares** an immutable release; API/worker activation is a separate manual
operation because authenticated readiness and the original production setup must be observed.
No deploy command builds inside a serving directory.

## Initial frontend transition

Run the frontend deploy workflow at the selected branch/SHA. It validates and builds frontend only,
publishes `/var/www/mailhub-frontend/releases/<sha>`, copies assets additively to `shared/assets/`,
and atomically switches `current`. Record the previous current target first. It never invokes PM2.

Before initially installing the backend-owned `deploy/nginx.conf`, copy the **existing monorepo**
`front-end/dist/assets/` into the new shared asset directory without deleting existing hashes.
This keeps previously open browser tabs working during the compatibility window. Also populate the
first new FE release before pointing Nginx at it. Keep the old checkout available for rollback.
After the keyless client is fully cut over, remove archived assets containing the retired browser
key as part of the approved key-rotation operation; append-only preservation must not make a
compromised key permanently downloadable.

Create `/etc/nginx/mailhub-backend-upstream.conf` with the observed current API endpoint (8080
in the template, but verify it), for example:

```nginx
server 127.0.0.1:8080 max_fails=3 fail_timeout=30s;
```

Back up the effective Nginx site and upstream files. Compare the template with the effective
configuration, preserving TLS, domains, proxy address/header chain and any operational overrides.
Under the common flock, install the reviewed site, run `sudo nginx -t`, and only then reload.
On test failure, restore the configuration before releasing the lock. HTTPS uses the reviewed
upstream and FE root; HTTP serves only ACME challenges and redirects all other requests. Check
static files, `/assets/`, index.html, public files, SPA fallback, and the canonical redirect.
The template serves ACME challenges on port 80 and redirects every other HTTP request with 308.
It sends HSTS with `includeSubDomains`; install that header only after confirming every production
subdomain is HTTPS-capable, because the directive also covers hosts outside this application.

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

Verify old FE/new BE and new/new. New FE/old BE is intentionally unsupported, so rollback must
restore the old FE before the old BE. Verify existing login refresh/cookie rotation/logout;
email verification; GitHub/Google login/link/revoke; callback error/deep-link reload; relay CRUD;
profile/admin views; stale tabs/assets/new tabs/back navigation; controlled mail/reply masking/SQS.
Frontend-only deployment must preserve API/worker PID and uptime. Backend-only deployment must
preserve FE current and file hashes. Repeat public, session and mail checks after each rollback.
Only then unfreeze production automation and mark the operational split complete.
