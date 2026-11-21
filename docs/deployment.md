# Independent deployment and rollback

## Activation gates

For the current API installation, activation, and rollback, use [API CodeDeploy](api-codedeploy.md) and [the workflow](../.github/workflows/deploy-api.yml). This does not activate or replace the worker.
A merge is not a production deployment.

1. Read the actual EC2 Node/npm versions, PM2 process names/CWD/script/uptime, Nginx configuration,
   active ports, free memory, and current artifact hashes. Record them outside Git without secrets.
   Node 24.14.1 is the validation runtime; verify compatibility on EC2 before activating deployment.
   Verify the non-interactive API service user also resolves this Node/npm version in PATH;
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
6. Restrict each GitHub `production` environment to reviewed `main`, with approval rules where available. Use repo-specific OIDC roles, deployment groups, and artifact prefixes. No runner SSH, ingress changes, static AWS keys, or runtime `.env` in Actions.
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

The first migration to the new FE root or API upstream is an explicit maintenance action. The CI runner must not edit live Nginx configuration. Never build in a serving directory.

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

## Independent API and worker operation

API activation must never replace the running worker, change its working directory, or garbage-collect its release. API candidate, authenticated readiness and guarded rollback are maintained in the backend [API runbook](https://github.com/private-mailhub/backend/blob/main/docs/api-codedeploy.md). If that implementation has not merged, keep the PM2 worker pinned and use the last reviewed operating procedure. Lambda cutover is a separate change; do not enable an SQS mapping or change worker count as a side effect of a frontend or API release.

## Independent rollback

Hold the same server lock and record exact current/previous release identities.

- **FE:** create a temporary symlink beside `current` to the recorded previous release, then
  `mv -Tf` it over `current`. Keep shared hash assets. On first migration the Nginx site backup
  can restore the original checkout if necessary. API/worker processes remain unchanged.
- **API:** start/verify the previous API at its recorded port if it was stopped. Restore upstream,
  run `nginx -t`, reload, verify public and session checks, then stop the failed candidate only.
- **Worker:** use a separate, drain-aware cutover runbook and the same durable delivery ledger in both consumers. Never start an older non-ledger consumer during a Lambda rollback. An API or FE rollback must not change the consumer.

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

## GitHub API deployment gates

- `CODEDEPLOY_ENABLED=true` is a **repository** variable permitting a manual run on `main`. Leave it unset while provisioning. `CODEDEPLOY_AUTO_ENABLED=true` is an additional opt-in for pushes; leave it unset until a successful release, rollback and public verification. Both are read before the production environment is entered.
- Set `AWS_REGION`, `AWS_ROLE_ARN`, `DEPLOY_BUCKET`, `CODEDEPLOY_APP`, `CODEDEPLOY_GROUP` as protected production variables from the shared foundation. Restrict that environment to protected `main`. Build jobs have no OIDC token; the publishing job pins CodeDeploy to the S3 VersionId returned from its own upload. No GitHub secrets containing runtime credentials or SSH keys are needed.
- Record actual prior FE release, API port and PM2 PID/CWD and worker SHA before deployment. The wait step reports CodeDeploy failure; the final runner check fetches the public homepage and its real JS. A failure *after* CodeDeploy success requires triage, not an assumption of automatic rollback. Confirm at the real site after each operation. No automatic DB migration or worker/Lambda activation is included.

For a cross-repository contract change, disable both automatic switches, cancel obsolete queued workflow runs, and serialize the compatible API and frontend revisions under the change record. The common host lock prevents concurrent changes, not an incorrect release order. Resume independent automatic releases only after verifying the new pair.
