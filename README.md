<p align="center">
  <img src="docs/main.png" alt="Mailhub logo" width="120" />
</p>

<h1 align="center">Mailhub</h1>

<p align="center">
  A privacy-first email relay that keeps your real address out of third-party services.
</p>

<p align="center">
  <a href="https://private-mailhub.com">Try Mailhub</a> ·
  <a href="https://github.com/private-mailhub/mailhub/releases">Releases</a> ·
  <a href="https://github.com/private-mailhub/mailhub/issues">Issues</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/private-mailhub/mailhub" alt="Latest release" />
  <img src="https://img.shields.io/badge/Node.js-24.14.1-brightgreen.svg" alt="Node.js 24.14.1" />
  <img src="https://img.shields.io/badge/NestJS-11.x-ea2845.svg" alt="NestJS 11" />
  <img src="https://img.shields.io/badge/React-18-61dafb.svg" alt="React 18" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="AGPL-3.0 license" /></a>
</p>

Mailhub creates private relay addresses such as `shop.7x9k@private-mailhub.com`. Use a different
address for each service, receive the messages in your real inbox, and disable an address whenever
it starts receiving unwanted mail.

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Self-hosting](#self-hosting)
- [Useful commands](#useful-commands)
- [Production deployment](#production-deployment)
- [Security](#security)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Relay addresses** — Create random or custom addresses for shopping, newsletters, sign-ups, and
  other services.
- **One-click control** — Add a label, copy an address, and turn forwarding on or off at any time.
- **Reply masking** — Reply to forwarded messages without exposing your primary address.
- **Flexible sign-in** — Use email verification or connect GitHub and Google OAuth.
- **Free tier** — Create up to 20 relay addresses on the current free tier.
- **Application-layer encryption** — Primary addresses and reply-routing values are stored as
  AES-256-GCM ciphertext. See [Security](#security) for the current key-management limitation.

## Screenshots

<p align="center">
  <img src="docs/main.png" alt="Mailhub relay address dashboard" width="800" />
</p>

## How it works

1. **Sign in** and choose an email verification code or an OAuth provider.
2. **Create a relay address** for the service you are using.
3. **Use the relay address** instead of your real email address.
4. **Receive messages normally** in your inbox. If the address becomes noisy, disable it without
   changing your primary email.

## Architecture

Mailhub separates the web application from the email worker. AWS services receive and queue inbound
mail, while the worker resolves the relay address and sends the message to the destination inbox.

```mermaid
flowchart LR
    Sender[External sender] -->|relay address| SES[Amazon SES]

    subgraph AWS[AWS]
        SES -->|store raw message| S3[Amazon S3]
        SES -->|enqueue event| SQS[Amazon SQS]
    end

    SQS --> Worker[Mailhub worker]
    S3 -->|load raw message| Worker
    Worker --> Redis[Redis]
    Worker --> DB[(MySQL)]
    Worker --> Mailer[Mailer]
    Mailer --> Inbox[Destination inbox]
```

### Email processing pipeline

| Step | Component | Responsibility |
| --- | --- | --- |
| 1 | Amazon SES | Receives mail for the configured relay domain. |
| 2 | Amazon S3 | Stores the raw MIME message. Configure S3 encryption and retention outside this repository. |
| 3 | Amazon SQS | Queues the S3 event for asynchronous processing. |
| 4 | Mailhub worker | Polls SQS, loads the message, and resolves the relay address. |
| 5 | Redis and MySQL | Cache and persist relay/account lookups. |
| 6 | Mailgun or SES | Forwards the processed message to the destination inbox. |

## Tech stack

| Area | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| Backend | Node.js, TypeScript, NestJS |
| Database | MySQL-compatible database through TypeORM |
| Cache | Redis |
| Inbound email | Amazon SES, S3, SQS |
| Outbound email | Mailgun in production, Amazon SES in other environments |
| Deployment | Nginx and PM2 |
| License | AGPL-3.0 |

## Self-hosting

This repository contains the NestJS API and SQS worker at its root. The React application lives in
[mailhub-frontend](https://github.com/private-mailhub/mailhub-frontend). Each repository installs,
checks, builds, and deploys independently.

This repository does not provision AWS or DNS resources. Before running a worker, configure a SES
receipt rule that stores mail in S3, an S3 event notification to SQS, IAM permissions for the worker,
and DNS/verified sending identities for the relay domain. Configure S3 encryption, retention, and
access policies in AWS; the application only reads the resulting SQS event and S3 object.

### Prerequisites

- Node.js 24.14.1 and its bundled npm for local/CI validation; verify the EC2 runtime before cutover
- MySQL 8+ or another MySQL-compatible database
- Redis 7+
- AWS account with SES, S3, and SQS configured for the relay domain
- Mailgun account for production outbound mail
- DNS access for the relay domain

OAuth providers are optional. Add GitHub and/or Google credentials only when you enable the matching
sign-in option. The backend has an Apple OAuth endpoint, but the current web UI does not expose an
Apple sign-in control.

### 1. Clone and install

```bash
git clone https://github.com/private-mailhub/mailhub.git
cd mailhub

npm ci

```

### 2. Configure the environment

Copy the checked-in examples and replace every placeholder before starting the backend:

```bash
cp .env.example .env
```

For a **new installation only**, generate a 32-byte Base64 value for `ENCRYPTION_KEY`.
During repository separation, retain the existing key and data:

```bash
openssl rand -base64 32
```

The current browser client requires the same value in `.env` as `ENCRYPTION_KEY` and in
the frontend repository’s `.env` as `VITE_ENCRYPTION_KEY`. Vite exposes `VITE_*` values in the browser bundle, so
this value is an implementation compatibility value, not a server-only secret. Never put a JWT,
AWS, Mailgun, OAuth, or other server secret in a `VITE_*` variable. Keep server-only values in a
secrets manager and never commit `.env` files.

The most important settings are:

| File | Variable | Example or note |
| --- | --- | --- |
| `.env` | `APP_NAME`, `APP_DOMAIN`, `PORT`, `CORS_ORIGINS` | Application identity, relay domain, listener, and allowed browser origins. |
| `.env` | `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USERNAME`, `DATABASE_PASSWORD` | Database connection. |
| `.env` | `REDIS_HOST`, `REDIS_PORT`, `REDIS_TTL` | Redis connection and cache lifetime. |
| `.env` | `JWT_SECRET`, `ENCRYPTION_KEY` | Server configuration; `ENCRYPTION_KEY` must decode to 32 bytes. |
| `.env` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_EMAIL_BUCKET`, `AWS_SQS_QUEUE_NAME`, `AWS_SQS_QUEUE_URL` | AWS SDK configuration used by the mail path and worker. |
| `.env` | `NO_REPLY_ADDRESS`, `CONTACT_ADDRESS` | Service and support addresses. |
| `.env` | `MAILGUN_API_KEY`, `MAILGUN_BASE_URL` | Valid Mailgun settings are required to send production mail. |
| `.env` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional; required only for the corresponding web OAuth flow. |
| `.env` | `APPLE_CLIENT_ID` | Used by the backend Apple OAuth endpoint; the current web UI does not expose that flow. |
| the frontend repository’s `.env` | `VITE_API_URL` | Local default: `http://localhost:8080`. Do not append `/api`. |
| the frontend repository’s `.env` | `VITE_ENCRYPTION_KEY` | Must match the backend value, but is visible to browser users. |

The backend validates its core startup configuration. See each repository’s `.env.example` file for the
complete list; optional OAuth settings are read only when their corresponding flow is used.

### 3. Initialize the database

There is no verified fresh-database bootstrap at this revision. Do not use
`scripts/init-db.sql` for a new production installation: it does not match the current entities.
The checked-in migration chain also assumes an older schema, including historical foreign-key and
index names, so it is not a safe replacement for the bootstrap script.

Use a schema baseline that you have validated against this revision before starting a new deployment.
For an existing installation, back up the database and validate the target schema in a disposable
environment before running `npm run migration:run`.

### 4. Start the applications

Start the API from this repository root:

```bash
npm run start:dev
```

The API is available at [http://localhost:8080/api](http://localhost:8080/api).
Follow the [frontend README](https://github.com/private-mailhub/mailhub-frontend#readme) to start the UI.

To run the SQS worker locally, start a second backend process with worker mode enabled. It requires
the AWS S3/SQS resources to be configured:

```bash
WORKER_MODE=true npm run start:dev
```

## Useful commands

### Backend

| Command | Purpose |
| --- | --- |
| `npm run start:dev` | Start the API in watch mode. |
| `npm run build` | Build the backend without modifying source files. |
| `npm run test` | Run unit tests. |
| `npm run test:e2e` | Run end-to-end tests. |
| `npm run migration:run` | Apply pending TypeORM migrations. |
| `npm run migration:revert` | Revert the latest migration. |

Also run `npm run lint`, `npm run typecheck`, `npm test -- --runInBand`, and
`npm run test:e2e -- --runInBand`. Formatting is an explicit, separate command.

## Production deployment

See [deployment and rollback](docs/deployment.md) and [split verification](docs/repository-split.md).
The templates in `deploy/` use immutable release directories, a candidate API, and a separately
selected worker. Production activation requires the documented runtime, environment, Nginx,
process, and authenticated readiness checks. No database migration is part of this split.

Set `NODE_ENV=production` to use Mailgun for outbound email. Other environments use Amazon SES.

## Security

- Primary email addresses and reply-routing values are encrypted with AES-256-GCM before database or
  cache storage.
- `VITE_ENCRYPTION_KEY` is intentionally available to the browser bundle in the current design. It
  can reduce accidental plaintext exposure in application storage, but it is not protection against
  a browser-bundle or key compromise. Do not describe it as a server-only encryption secret.
- Use a separate, randomly generated `JWT_SECRET` per environment. Treat AWS, Mailgun, and OAuth
  credentials as server-only secrets.
- Grant AWS and Mailgun credentials only the permissions required by the deployment.
- Do not commit `.env` files, private keys, API keys, or production data.

To report a vulnerability, please do not open a public issue. Email
[contact@private-mail.com](mailto:contact@private-mail.com) instead.

## Roadmap

- [ ] Improve reply-relay handling and sender privacy
- [ ] Move the email worker to AWS Lambda for cost efficiency
- [ ] Add AI-powered email summarization
- [ ] Add browser extension and mobile apps

## Contributing

Issues and pull requests are welcome. Before opening a pull request:

1. Keep changes focused and explain the user-visible impact.
2. Run the relevant backend tests and frontend lint/build commands.
3. Never include secrets or real email addresses in commits, tests, or screenshots.

For security vulnerabilities, use the private reporting channel above instead of a public issue.

## License

Mailhub is licensed under the [GNU Affero General Public License v3.0](LICENSE).
