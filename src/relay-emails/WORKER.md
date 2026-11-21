# Shared mail record processor

`MailRecordModule` exports `MailRecordProcessor.processSqsBody(body): Promise<void>`. The Lambda host supplies a global `CustomEnvService` and a default TypeORM connection to the **same MySQL primary** as the PM2 fallback. Register `MailDelivery`, `RelayEmail`, `ReplyMasking`, `User` and `EmailForwardingLog` plus any other entities their relations require. The feature imports no HTTP server, cron, SQS receiver, Redis or API configuration. For an isolated environment use `MailRecordModule.withTransport(CaptureClass)`, an isolated bucket, queue and **separate DB**. Capture must never send mail; a capture receipt must never enter the production ledger.

Acknowledgement means all S3 records in the SQS body reached a durable terminal state. The only non-mail notification accepted is the documented S3 service test event. The worker accepts direct S3 and SNS Notification envelopes. Bad input, wrong bucket, unknown/in-progress outcome, configuration failure and failed S3/DB/transport operations reject the message. Later siblings are still attempted; a retry does not resend completed siblings. Unknown relay, inactive relay and unknown reply-mask mappings are intentionally recorded as `skipped`. Missing sender/recipient or failed reply-mask creation is not a silent skip.

## State and identity

`mail_deliveries.record_id` is the lowercase SHA-256 of UTF-8 `JSON.stringify([bucket, decodedKey, 'version', versionId])` or `[bucket, decodedKey, 'sequencer', canonicalSequencer]`. S3 form-encoding is decoded **once**. A real version ID is fetched explicitly; `null`/absent versions require a hex sequencer (lowercase, no leading zeros except `0`) and a matching S3 ETag via `If-Match`. An overwritten/unavailable object is retried/redriven rather than sending different mail. Queue IDs, receipt handles and provider IDs are not object identities.

| State | Meaning on redelivery |
| --- | --- |
| `ready` | Retry preparation immediately. |
| `preparing` | Another owner may be reading/preparing. Refuse to send. Only this state can be reclaimed after its 120s DB-clock lease; a stale owner cannot promote or release its successor. |
| `sending` | Irreversible submission fence committed. A process might be between commit and the network call, in the call, or accepted before a receipt commit. Never re-claim or acknowledge this state, even if old. |
| `unknown` | Submission did not yield a trustworthy, durably recorded result. Never auto-resend or acknowledge. |
| `sent` | Provider accepted and its receipt ID was durably committed. Skip on redelivery; this is acceptance, not inbox delivery. |
| `skipped` | An intentional policy decision and reason were durably committed. Skip on redelivery. |

Route lookup, reply-mask persistence, MIME/attachment creation and request construction finish before `beginSend`. The single outbound submission runs only after a successful fenced commit. The normal production path uses Mailgun MIME, no application retry or follow-redirect; the nonproduction SES sandbox uses one SDK attempt. Forward counts and forwarding-log writes are best effort **after** receipt persistence and do not cause another delivery.

## Operator gates (not run by the worker)

1. Review the additive migration `src/migrations/1795219200000-AddMailDeliveries.ts` and apply it manually in the intended environment with the migration principal. Keep `synchronize` and `migrationsRun` disabled. Do not drop/prune this table on rollback, or restore it behind the queue. Do not assume old sends exist in this new table.
2. Validate with synthetic identities, isolated resources and capture-only transport. Confirm production-shaped direct/SNS notifications have version IDs or sequencer + ETag, and permissions for the actual `GetObject`/`GetObjectVersion` path. Configure queue retention, DLQ/redrive and alerts; the retry window must outlive the pre-send lease plus long-poll/visibility/processing budget. Unsafe source or missing gates means **do not enable**.
3. Establish a ledger-aware **PM2 fallback** before switching. Never overlap a pre-ledger consumer with this worker. Fence inbound traffic/consumption and reconcile historical, delayed or in-flight events with uncertain pre-ledger delivery. Current PM2 uses a 20s long poll; configure PM2 `kill_timeout` longer than the maximum active batch and DB/network timeouts, observe `Queue polling drained`, confirm zero old consumers, then switch. A SIGKILL is not evidence that a send did not occur. On rollback stop/disable and drain Lambda first, then resume only the verified ledger-aware PM2 release using the same primary.
4. Reconcile `sending`/`unknown` from the DLQ and ledger together. Derive the record ID from the **original event** and query provider acceptance using `<mailhub-{record_id}@{APP_DOMAIN}>`, the MIME Message-ID, plus the stored provider receipt where available. Stop/fence all involved owners and wait for potentially live requests before any manual decision. A missing provider event or an aging lease is not proof of non-acceptance. If acceptance is proven, use an audited, owner/state-checked operator repair to `sent` with provider receipt and reprocess the envelope; siblings keep their own states. Only proven non-submission with no possible live attempt is eligible for an approved re-drive. If inconclusive, retain/quarantine without resending. No automatic reset, TTL, destructive migration revert or replay tool is supplied.

Local checks: `npm test -- --runInBand test/relay-emails` uses synthetic MIME, mocked SDK/Fetch and a temporary in-memory SQL repository. It does not apply migrations or contact any provider. It is not proof of live MySQL/Mailgun/queue behavior.

The worker-only PM2 `kill_timeout` is 180 seconds; never use time elapsed as evidence of drain. If a forced termination occurred, reconcile unresolved sends against the durable ledger and provider before handing consumption to the other runtime. Keep the original message/queue intact.
