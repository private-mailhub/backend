# Mailhub backend

This repository contains a NestJS 11 / TypeScript API and SQS worker, with TypeORM/MySQL and Redis.
The React frontend is maintained in https://github.com/private-mailhub/mailhub-frontend.
Use the actual TypeScript/ES module style of adjacent files; the application is not Express/CommonJS.

- Run from this repository root with the Node version in `.nvmrc`.
- Install with `npm ci --engine-strict`; do not add dependencies without approval.
- Validate with `npm run lint`, `npm run typecheck`, `npm test -- --runInBand`,
  `npm run test:e2e -- --runInBand`, and `npm run build`.
- Build and checks must not modify source. Formatting and lint fixes are explicit commands.
- Delegate planning, test-first coverage, backend implementation, and code review as separate roles.
  Follow the shared subagent-orchestration skill when available; write code review reports in Korean.
- Tests mock DB, Redis, AWS and mail. Never connect automated tests to production resources.
- Preserve `/api`, response wrappers, authentication/cookie settings, CORS behavior and encryption format.
- Use security review for changes to authentication, encryption, sensitive data or deployment trust.
- Do not run database bootstrap/migrations or change keys as part of repository separation.
- Deploy only immutable releases using `deploy/` and `docs/deployment.md`; do not build in serving
  directories, invoke `pm2 reload all`, or modify frontend artifacts from backend workflows.
- Commit small verified changes and their tests together using the existing capitalized prefix convention.
- Keep real `.env*`, PEM files and personal `.claude` settings untracked.
