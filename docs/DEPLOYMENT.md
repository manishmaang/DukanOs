# AWS supervised pilot preparation

Repository safeguards and templates are prepared; **nothing has been deployed or provisioned in AWS**. Read the historical [readiness audit and follow-up](PRODUCTION_READINESS_AUDIT.md) and [checkpoint](checkpoints/aws-pilot-preparation.md) before opening customer traffic. Automated local tests do not certify AWS recovery, TLS, firewall rules, sizing or uptime.

## One authority and the recommended installation

Use one EC2 Linux host running Nginx HTTPS, the compiled React assets and **one** NestJS process with the existing maintenance/report workers. Store uploads on encrypted persistent EBS at `/var/lib/dukanos`. Prefer **private RDS PostgreSQL 16** when the budget supports managed patching, backups and recovery. Keep public access disabled; permit port 5432 only from the application's security group. Use the current AWS CA bundle and a verified database hostname. RDS backups alone do not recover uploaded files.

PostgreSQL 16 on the same EC2 host is a potentially cheaper supervised-pilot option. Bind it to loopback and accept responsibility for database patching, disk capacity, consistent backups, off-instance copies and restore drills. A single host is also a single failure domain. This task makes no AWS price or capacity claim; measure the target host with realistic multi-device use before selecting its size. RDS increases recurring cost while reducing database administration work.

The supported/tested baseline is Node **24.13.1**, PostgreSQL **16.15**, Linux amd64, and Nginx **1.24.0 with Ubuntu security patches** (local test package 1.24.0-2ubuntu7.18). Use reviewed, security-patched releases in those major lines and rerun the release checks when upgrading. Backup tooling uses PostgreSQL 16 client tools, GNU tar, GnuPG 2, Git, util-linux `flock`, and optionally AWS CLI v2 for encrypted S3 copies. No Redis, Kafka, container scheduler, CloudFront or separate frontend hosting is required.

**Cloud-only shop operation needs WAN.** This pilot does not provide disconnected browser writes, automatic LAN fallback or a second writable local database. Existing LAN continuity still applies when the entire application/database is installed locally. Do not run local and cloud copies as concurrent restaurant authorities.

## Release preparation (build before changing the running service)

1. Check out a reviewed commit in `/opt/dukanos/releases/<commit>`; preserve Git metadata for the backup release reference. Run `npm ci`, `npm run check`, `npm run test:integration`, both npm audits and the browser regression commands in README. Tests need disposable PostgreSQL privileges; never point destructive test fixtures at a restaurant production server.
2. Preserve `apps/api/dist`, `apps/web/dist`, `database/migrations`, `scripts`, `deploy`, workspace packages, package manifests/lockfile and compatible production `node_modules`. Build on the deployment architecture so Sharp's native dependencies match. The full-backup script captures these artifacts for offline recovery.
3. Create a non-root `dukanos` OS user. Release files must be read-only to that user. Create `/var/lib/dukanos/uploads/menu` and `/var/lib/dukanos/uploads/expenses`, owned by that user, mode 0700. Keep data outside every release directory.
4. Keep protected configuration under `/etc/dukanos`; runtime/backup environment files must not be in Git. Use root-owned mode 0600 for environment files (systemd reads them before switching user), a restricted directory, and service-readable CA certificate files. Keep exact rendered service/proxy configuration and TLS/recovery material in this protected recovery set. Store the backup decryption private key separately, off the server; never rely on a key encrypted inside its own backup.
5. Stop the app for a reviewed schema/release change, take a verified full recovery point, apply migrations with the maintenance identity, refresh explicit runtime grants, update `/opt/dukanos/current`, then start. Do not use development hot reload or run seeds.

## Database identities and migration sequence

Use a dedicated application database, an administrative provisioning connection, a migration/maintenance login that owns the `dukanos` schema, and a distinct restricted runtime login. Choose actual role/database names; placeholders below are not credentials.

In a protected provisioning environment file set `DATABASE_URL` to the database-administrator connection and set `DUKANOS_MIGRATION_ROLE`, `DUKANOS_RUNTIME_ROLE`, `DUKANOS_DB_SCHEMA=dukanos`. After the administrator creates the dedicated database:

```sh
node --env-file=/etc/dukanos/provision.env scripts/provision-database.mjs setup
```

This repeat-safe operation creates unprivileged login roles without passwords, owns the new schema with the migration role, removes public database/schema creation access, and configures database-specific search paths. It refuses privileged existing roles, runtime role membership and an existing schema owned by someone else. It deliberately refuses the shared `public` schema. Use `psql`'s interactive `\password` command over a trusted/verified connection to set each role's distinct password; never pass passwords in shell arguments/history.

Set a protected maintenance environment file's `DATABASE_URL` to the migration identity. Then:

```sh
node --env-file=/etc/dukanos/maintenance.env scripts/migrate.mjs
node --env-file=/etc/dukanos/maintenance.env scripts/provision-database.mjs grant
```

The grant step needs the same three non-secret role/schema variables. It replaces runtime grants with the release's explicit table/column DML, SELECT and function EXECUTE requirements. UUIDs and allocator tables need no sequences in this release. Run this step after future reviewed migrations and update its table list when a module needs new operations. No runtime ownership, schema CREATE, TRUNCATE, TRIGGER, migration-ledger writes, SUPERUSER, CREATEDB or CREATEROLE is granted. Do not give the runtime user migration-role membership. Do not change the development database credentials to install this profile.

Migration 019 preserves existing records and introduces system-only historical cancellation. It does not run cleanup itself. **First startup after today's cutoff can cancel real old unfinished rounds and create legitimate refund obligations.** Review old work before enabling this release. Do not edit an applied migration; ledger/file checksums must match exactly.

## Runtime configuration

The production service uses `scripts/start-production.cjs`; it refuses missing or non-production NODE_ENV. `npm run start:production` uses the same entry point with an already supplied environment. For an explicit protected file:

```sh
node --env-file=/etc/dukanos/runtime.env scripts/start-production.cjs
```

| Setting                                                          | Production rule                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NODE_ENV                                                         | Exactly `production`; other entry points also reject misspellings. Development/test remain explicit supported modes.                                                                                                                            |
| DATABASE_URL                                                     | Required restricted runtime connection. Remote hosts require `sslmode=verify-full` and a trusted CA (for RDS, `sslrootcert=/etc/dukanos/rds-ca.pem`). Host overrides in query parameters are rejected. No credentials in browser configuration. |
| HOST / PORT                                                      | `127.0.0.1` / `3000` for supplied proxy/monitor templates; production refuses a non-loopback binding. If changing the port, update all three configurations together.                                                                           |
| DUKANOS_DATA_DIR                                                 | Required absolute persistent directory, `/var/lib/dukanos` in systemd template. Both upload directories must be writable by the service.                                                                                                        |
| RESTAURANT_TIMEZONE                                              | Default `Asia/Kolkata`, validated IANA zone. Business dates/tokens reset at calendar midnight. Review timezone changes deliberately.                                                                                                            |
| PREVIOUS_DAY_ORDER_CLEANUP_TIME                                  | Default `05:00`; strict 24-hour HH:MM. Before today's cutoff no past-date cleanup runs, including older overdue work. At/after cutoff all earlier-date QUEUED/PREPARING/READY orders qualify.                                                   |
| ORDER_TAX_RATE / ORDER_TAX_LABEL                                 | Default `0` / `Tax`; existing validated generic tax configuration. Owner supplies applicable billing settings; existing sale snapshots remain unchanged.                                                                                        |
| KITCHEN_LATE_THRESHOLD_MINUTES / DISPATCH_LATE_THRESHOLD_MINUTES | Default 15 / 5, attention indicators only.                                                                                                                                                                                                      |
| DAILY_REPORT_DELAY_MINUTES                                       | Default 5 after midnight; generation schedule is unchanged by the 05:00 cleanup gate.                                                                                                                                                           |
| SMTP_HOST                                                        | Blank disables transport only. Reports and restaurant operations still work.                                                                                                                                                                    |
| SMTP_PORT / SMTP_SECURE                                          | Defaults 587 / false. Remote transport requires verified STARTTLS or implicit TLS; loopback capture/relay may use plaintext.                                                                                                                    |
| SMTP_USERNAME / SMTP_PASSWORD                                    | Supply both or neither; protected runtime environment only.                                                                                                                                                                                     |
| EMAIL_FROM_ADDRESS / EMAIL_FROM_NAME                             | Valid configured sender when SMTP enabled; display name defaults DukanOS. Recipient settings remain in the audited application UI and initially OFF.                                                                                            |

See `.env.example` for development defaults, not production credentials. Never put real secrets there. Use no external frontend runtime assets. Secure/HttpOnly/SameSite=Strict cookies and the X-DukanOS-Request mutation requirement remain mandatory; no permissive CORS is introduced.

## HTTPS and network boundary

Render [deploy/nginx.conf.example](../deploy/nginx.conf.example) with the actual hostname, certificate chain and private-key paths. Obtain/renew a trusted certificate using the chosen DNS/ACME process; no domain or certificate was created here. Test `nginx -t` before reload. Nginx was selected because one maintained OS service can provide TLS, bounded uploads and same-origin forwarding without adding application infrastructure.

Only Nginx on the same host connects to the IPv4-loopback API. Express trusts **only hop zero from 127.0.0.1 or its exact IPv4-mapped form**. Nginx overwrites X-Forwarded-For/Proto/Host and removes Forwarded; it never appends an attacker-supplied chain. Do not place an ALB, CDN or second proxy in front without reviewing and testing this boundary. Local OS users/services are trusted; do not share the machine with untrusted workloads.

- Permit public TCP 443 and, if needed for ACME/redirect, 80. Restrict SSH/admin access by VPN/approved sources or use SSM. Never open API 3000 or PostgreSQL 5432 publicly.
- `/api` preserves method, status, query, cookies and the mutation header. No proxy caching, compression or retry of API mutations; API failures never become index.html.
- Hashed `/assets/` responses get public long caching and gzip. HTML is revalidated. Authenticated menu/receipt routes stay in uncached `/api`.
- HSTS, nosniff, referrer and CSP headers are supplied. Verify final inherited headers when integrating with any site-wide Nginx configuration. The HTML permits local inline styles used by the UI; scripts remain same-origin.
- Login has a proxy limit of six requests/minute/IP with a burst of ten, supplementing the unchanged persistent account/IP counters. The shared expensive-work zone caps active upload requests at two and login requests at four per virtual host; target-host testing must confirm these fit staffing and memory.
- Request body limit 6MiB allows multipart overhead around the unchanged application 5MiB image limit. Images remain JPEG/PNG/WebP only, ≤24MP, non-animated; menu/receipt normalization remains unchanged.
- Access logging is disabled; critical proxy errors only. Do not enable request/body/header debug logs. Install log rotation for the bounded Nginx error log and journal.

Before customer traffic, use real phones/tablets through actual HTTPS to test login/cookies, uploads, POS, payments, Kitchen/Dispatch and audio. The local regression uses an isolated self-signed TLS fixture; that is not a production certificate or real-device certification.

## Startup, readiness and supervision

Install/render [dukanos.service](../deploy/dukanos.service), enable it for reboot, and start it only after schema/grants/media/configuration/TLS are prepared. It runs compiled code as a non-root user, automatically restarts failures, constrains writable paths and uses SIGTERM. The app waits for schema/assets/media/role readiness and initial rollover before listening. Missing migrations/checksum mismatch, required table/view/function/enabled-trigger absence, an unsafe production DB identity or missing compiled index/referenced assets fails startup. No schema repair, seed or owner creation runs automatically.

`GET /api/health` is liveness. `GET /api/health/ready` checks connectivity each time and release/schema/media prerequisites at most every 30 seconds (coalesced). Failures return sanitized 503 SERVICE_NOT_READY; the process can remain alive during a dependency outage. The schema object inventory follows the repository's unquoted migration declarations; future rename/drop/schema conventions must update this verification deliberately. Readiness is not a repair system.

Database pool: five connections, 2-second acquisition/connect timeout, 9-second PostgreSQL statement timeout, 10-second client query timeout, 15-second idle-in-transaction timeout. Reports retain their 8-second local statement limit. HTTP request body/header limits are 30/15 seconds; socket inactivity 60 seconds and keepalive 5 seconds. Proxy connect/send/read are 3/30/60 seconds. Statements time out at PostgreSQL; financial operations retain transactions and idempotency. Shutdown waits for in-flight workers, stops further cycles and has a 90-second process deadline, with systemd's 100-second stop budget. A forced stop can leave an uncertain SMTP attempt; its existing lease/retry policy applies.

After a timeout during collection/confirmation, reopen/refetch the Bill/order and reconcile the existing operation/request ID before another collection. Never treat a timeout as proof of non-payment or generate a new payment key simply to retry. Queued email transport has at-least-once acceptance semantics; inspect delivery history before a manual resend.

The initial owner is created only by the explicit stdin bootstrap command after migration; staff/password workflows are unchanged. Recovery remains the hidden-input, loopback-only `auth:reset-owner` tool. For RDS, prepare and rehearse a controlled TLS-verified loopback tunnel before relying on that recovery command; direct remote recovery remains intentionally refused. Do not disable remote database certificate checks to make recovery work.

## Full backups and isolated restore

[backup.mjs](../scripts/backup.mjs) creates a timestamped encrypted full recovery bundle using established pg_dump/pg_restore, tar and GnuPG tools. It includes DB contents and migration ledger, role flags/grant metadata without password hashes, both upload directories, the protected configuration directory, built release/dependencies and a checksummed manifest. It verifies referenced image/receipt bytes, records financial totals/table counts/staff role assignments and validates the dump catalog. CLI errors suppress potentially secret-bearing child output.

Prepare a verified GnuPG **public** recipient fingerprint on the host; keep the private key/recovery passphrase offline with the owner. Copy [backup.env.example](../deploy/backup.env.example) to protected `/etc/dukanos/backup.env`, fill real maintenance credentials/schema/paths/fingerprint, and choose either:

- `BACKUP_S3_URI=s3://<actual-private-bucket>/<prefix>/`: AWS CLI uses the instance role, encrypted uploads and SHA256 checksums. Configure bucket public-access blocking, encryption, least-privilege prefix access, versioning and retention/lifecycle separately. No AWS action has been executed by this task.
- `BACKUP_OFFSITE_DIR`: a pre-mounted secured **off-instance** destination. The script copies and compares SHA256; a directory on the same EC2/EBS disk is not off-instance protection. Mount identity/availability is an operator verification, not inferred from a path.

The maintenance wrapper stops DukanOS, checks there are no other DB clients, captures DB+files with writes quiesced, encrypts and copies off-instance, then restarts even on failure. The systemd unit also has an ExecStopPost restart safeguard. Keep all other writers/admin sessions disconnected. Do not invoke it on a running restaurant outside an agreed window. A clean committed release is required for real backups. A failed copy leaves the local encrypted artifact but does not record backup success or prune old artifacts. Local retention defaults to 14 days, minimum 7; remote retention is configured separately. Temporary plaintext is mode-restricted and removed after normal success/failure; encrypted EBS and restricted access remain required for crash remnants.

The supplied timer uses **23:45 UTC (05:15 Asia/Kolkata)**. It is a template, not an agreed recovery objective. It deliberately does not run a missed shutdown job automatically at reboot. Monitor missed backups and arrange a safe catch-up window. Select recovery-point/recovery-time objectives with the owner; once daily can lose a full shift. Backups pause service through copy completion; measure the interruption and off-instance bandwidth. For tighter objectives, evaluate RDS PITR plus a deliberately consistent file recovery strategy rather than pretending this daily bundle provides zero loss.

Install/enable the backup service/timer only after a successful manual run. Inspect backup exit status and `BACKUP_DIR/last-success.json`; success means encrypted creation plus a successful off-instance transfer, not merely a DB dump. The pipeline is prepared but scheduling, keys, off-instance destination and alarms are **not configured on AWS**.

For rehearsal, create a new empty database whose name starts `dukanos_restore_`, on an isolated PostgreSQL instance/network. Set DATABASE_URL to that empty database, BACKUP_ARTIFACT to the chosen encrypted bundle and RESTORE_DIRECTORY to a new absolute restricted directory, with the decryption key available securely:

```sh
node --env-file=/secure/restore.env scripts/backup.mjs restore-fixture
```

The command refuses other names, existing output directories and nonempty target databases, never uses `--clean` or DROP, checks file hashes and dump catalog, restores without old owners/ACLs, compares exact inventory/financial totals/roles/migration ledger and referenced media bytes, and extracts configuration/release without starting any application or SMTP worker. The prefix is a safety guard, **not network isolation**: the operator must provide the isolated target. Imported credentials are recovery evidence; do not automatically load them or enable outbound SMTP. Re-provision appropriate roles/grants with fresh credentials before a controlled application verification. Validate pending report/delivery history and reconcile real-world payments made after the recovery point before reopening.

The automated disposable rehearsal exercises separate maintenance/runtime provisioning, actual menu/receipt uploads, users/RBAC, an order/payment/expense, report history, encryption/decryption, artifact compatibility and corruption/overwrite rejection. It proves this local tool path, not RDS PITR or AWS disaster recovery. Never let original and restored systems accept restaurant writes simultaneously. A restored snapshot can lose newer idempotency keys and accepted email history; reconcile before sending/collecting again.

## Monitoring and supervised operation

Install the monitor service/timer after configuring protected environment files. [monitor.mjs](../scripts/monitor.mjs) exits nonzero and emits a sanitized JSON failure list for API readiness, DB/report cursor freshness, free disk/inodes (10% and 1GiB floor), backup age (26 hours), worker heartbeat/errors, repeated HTTP 500s and repeated startup events. A nonzero systemd NRestarts counter also flags a crash restart; investigate before acknowledging/resetting the service's failed state. It inspects the local journal; no external service is needed for transactions. Bind it to the runtime DB credentials (the runtime environment file overrides backup credentials in the unit). Persistent journaling and journal size limits must be configured on the host.

Structured application events include server-generated request IDs on responses/5xx records, startup/shutdown, rollover and Daily Worker success/failure. No request URLs, raw errors, request bodies, passwords, cookies, recipients or connection strings are logged. Worker monitoring uses a three-minute freshness threshold and a ten-minute error window; investigate slow SMTP cycles as well as stopped jobs. Report cursor monitoring detects catch-up lag beyond yesterday, while email job failures remain separately visible in Daily Reports. Application liveness alone does not prove that backups or workers are healthy.

Configure an **operator notification path** for failed monitor/backup units and a separate external host-unavailable check during AWS setup (for example CloudWatch instance/system checks plus disk/log/backup alarms and an actual tested recipient). Local checks cannot report a powered-off host by themselves. No monitoring SaaS dependency or AWS alarms were installed here. Verify disk-full, DB-loss, SIGTERM/crash, EC2 reboot and backup-failure recovery on the target host before accepting customer traffic.

SMTP 4xx recipient rejections now retry as SMTP_UNAVAILABLE; applicable permanent EENVELOPE failures are RECIPIENT_REJECTED/FAILED. Existing 1/5/15/30/60-minute capped backoff, leases, immutable report versions and delivery records are unchanged. Real external delivery requires a deliberate production test with the actual provider; automated tests use loopback only.

## Rollback and remaining gates

Prefer a reviewed forward fix. Switching source cannot undo a migration. A rollback needs an explicitly compatible release or a matched DB+media+configuration recovery set with reconciliation of subsequent real-world transactions. Never truncate financial history or replace uploads to make an older build start. Preserve fixed MVP tags.

**Before traffic:** actual hostname/TLS/renewal; EC2/security groups/private DB; correct least-privilege runtime credentials and verified RDS CA; persistent volumes/ownership; backup key custody/off-instance retention and successful AWS-host restore; owner recovery rehearsal; supervisor/reboot tests; alarm delivery; target-host capacity; real-device HTTPS/audio/camera behavior; approved maintenance window/RPO and acceptance of cloud WAN dependence. These are setup conditions, not completed infrastructure.

References: [Express proxy trust](https://expressjs.com/en/guide/behind-proxies/), [Nginx proxy behavior](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [PostgreSQL timeouts](https://www.postgresql.org/docs/16/runtime-config-client.html), [RDS verified TLS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html). Verify current host/vendor security updates again at release time.

## Manual platform release (020)

This feature needs reviewed migration 020 and refreshed runtime grants alongside matching builds. Platform cancellation INSERT is added to the explicit grant list; schema-aware startup must continue refusing missing/mismatched releases. No migration has been applied to restaurant data by feature tests. Obtain explicit authorization before a live backup/maintenance/migration operation. No AWS resources or deployment are part of this feature. After an authorized upgrade, a Menu administrator must configure real platform serving quantities/availability before staff entry; no food quantities or external credentials are seeded. Counter preparation/billing remains separate.
