# Repository split verification — 2026-09-07

## Source and history

- Original main: `3ff068ba6a206e825cc9dd32ef39490298926a49`.
- Original production: `600e3a20b5a7624c82b0f109159e05704ca841eb`.
- Backend remains https://github.com/private-mailhub/mailhub; no history rewrite or force-push.
- Frontend: https://github.com/private-mailhub/mailhub-frontend (initially private).
- Local backup: `/Users/andy/mailhub-split-20260907/mailhub-before-split.bundle`.
  `git bundle verify` succeeded; includes local `feat/mailhub-cli` and all original refs.
- Remote mirror: `/Users/andy/mailhub-split-20260907/upstream.git`; `git fsck --full` succeeded.
- Filter tool: git-filter-repo 2.47.0, installed in a separate tools virtual environment.
- Filtered paths: front-end/, eslint.config.base.mjs, .prettierrc, .gitignore,
  LICENSE, README.md, docs/, .github/FUNDING.yml. Tags use `monolith-` prefix.
- No environments, PEMs, node_modules, or build output were copied into the extracted history.
  This does not certify the absence of all historical secrets.
- Frontend subtree equality before flattening: main `e89ef46e6eab3967fdb33d24f42cd83004514eea`,
  production `a256d5f9ab86d9e26149aa77d0b44965b8d04a55`; both matched original tree IDs.
- Frontend flattening is a normal rename commit `5f8239d`; original authored history is retained.
- [Commit map](split-records/frontend-commit-map.txt) maps original to extracted SHAs.
- [Original refs](split-records/original-refs.txt) and
  [extracted refs](split-records/frontend-refs.txt) record the extraction snapshot.

## Preserved work

Original branches, tags, issues, PRs, and releases remain in the backend repository.
The unmerged local CLI work and remote Lambda work were not merged or deleted.
Port those features by subsystem after separation; do not reintroduce frontend code into backend.
Actual .env/PEM files and personal .claude settings stay local. The implementation checklist
`to-do-implementation.md` remains untracked at the user's request.

## Validation status and rollout gates

The CI/local validation runtime is Node 24.14.1; it is **not** an observed EC2 runtime.
The previous local Node 20.15.0 does not satisfy all locked package engines.
Dependency versions and database schema remain unchanged.

Production execution is pending, not claimed as completed:

- EC2 SSH host/user/port, actual Node/npm, Nginx/PM2 config, active process CWD and artifact hashes.
- Environment file supply, existing FE build values, DB backup recovery, resource headroom.
- AWS OIDC trust and deploy permissions for the new frontend repository; SSH security group port.
- Existing and candidate authenticated DB/Redis readiness, session fingerprint compatibility.
- Browser matrix (old FE/new BE, new FE/old BE, new/new), OAuth, controlled mail/SQS validation.
- Actual releases, worker consumer count, independent rollback and post-rollback checks.

No production pointer, process, environment secret, IAM policy, database, or runtime was changed.
Existing production deployment/merges must be frozen before the actual cutover. Recheck original
main/production refs against this snapshot before merging, and port any intervening changes.
Keep new deployment activation disabled until the operations runbook gates are satisfied.

## Local application checks completed

- Frontend independent root: npm ci --engine-strict, lint (0 errors / 25 existing warnings),
  app+node typecheck, build and build:prod all passed with Node 24.14.1.
- Backend new root: npm ci --engine-strict, lint (0 errors / 5 existing warnings), typecheck,
  unit (4 suites / 32 tests), mocked HTTP E2E (4 tests), and pure build all passed.
- Unit fixtures intentionally exercise invalid ciphertext; E2E fixtures intentionally return 401.
  Their expected error logs are not connections to external services.
- `.env.example` and `src/logs` remain trackable; real environment files and PEMs are ignored.
- Source checks/builds did not modify tracked source files. Production dependencies retain lockfiles.
- Real browser/account/mail checks and live Nginx/PM2/rollback checks remain pending as listed above.

## Deployment validation and review

- Both release harnesses passed locally, using real fcntl locking via a test-only shim where
  util-linux flock is unavailable; Ubuntu CI uses its installed flock.
- Covered immutable SHA releases, failed installation without publication, environment isolation
  during install, public files, old/new hashed assets, collisions, umask 077, nested paths and
  permissions readable by Nginx. Neither release script activates API/worker processes.
- Production backend installation with --omit=dev --engine-strict --ignore-scripts succeeded
  in a fresh isolated directory; all 22 runtime package imports passed without runtime environment.
  The locked production lifecycle script is NestJS's optional donation prompt.
- All four workflows passed actionlint 1.7.12. Shell syntax and git diff checks passed.
- Code review and security re-review reported no remaining P1/P2 issues after corrections.
- Live Nginx syntax validation, EC2 deployment, browser accounts, mail and rollback are still gated
  on the unverified operational facts above; local tests do not substitute for those checks.
