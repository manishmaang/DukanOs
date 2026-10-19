> **Latest owner-reported status — 19 October 2026:** Test-data cleanup committed and independently checked by the owner; do not rerun it. Real-shop use was reported successful, with specific tweaks still pending. Three EventBridge schedules exist but are DISABLED; the guarded 05:45 stop does not exist. SSM managed-node listing is confirmed, Ping Online and Run Command are not. See [October 19 production/scheduler handoff](EC2_AUTO_START_STOP_HANDOFF_2026-10-19.md) for the paused Step 15 checkpoint, IAM changes, exact schedule names and recovery limitations. No live verification occurred during this context update. Older observations below are historical.

> **Historical October 18 preparation overlay (superseded by the completion report above):** Overnight jobs changed the cleanup inventory to five system-cancelled orders, 18 history events, three Counter amendments, two Zomato cancellation records and eight daily reports. The owner authorizes preparation to remove only the same seven test orders/dependencies plus October 17 v1; preserve October 10–16, all 293 menu audits and numbering 7/5. Previous cleanup scripts/runbooks are superseded. See [final runbook](TEST_ORDER_CLEANUP_2026-10-17.md). Production report cursor, no external sends, fresh backup and unchanged inventory remain preflight conditions. No agent production access or action occurred. Transfer, inspection, dry run and commit each await separate owner authorization. Historical observations below are not current deployment verification.

# DukanOS — AWS Cloud Deployment & Recovery Handover

**Snapshot date:** 12 October 2026 (IST)

**Purpose:** Self-contained operational context for the owner, a future ChatGPT session, or Codex. Covers **what was actually deployed and tested**, where things live, how to inspect them safely, and what remains before a real-shop pilot.

**Scope:** One restaurant, one EC2 host, local PostgreSQL, HTTPS, S3 encrypted backups.

**Evidence basis:** Commands/results shared during the supervised AWS setup and the deployment code pinned to `fdef4f7b41d6a26bb88ef29d30e5e9ec640d70f7`. This is a **dated snapshot**, not live AWS inventory. Verify anything that may have changed before acting.

> **Codex / new-agent entry point:** Read this file **and** `AGENTS.md`, `docs/SYSTEM.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/DECISIONS.md`, `docs/DEPLOYMENT.md`, and the affected module docs. Inspect real code and actual AWS state. Some older repo documents say AWS has not yet been provisioned: that was true when those documents were written, **not as of this handover**. Do not treat this note as authorization to modify live infrastructure. Follow the repo's branch/checkpoint/update-docs rules. Never echo credentials, copy production data into Git, run integration tests against production, or alter live financial history.

## Current context reconciliation — 13 October 2026

This repository copy preserves the owner's **12 October handover evidence** below. It was reconciled with later owner statements on 13 October; no AWS connection, production query, deployment or infrastructure change was performed for this documentation update. Historical test results are not a fresh health check.

- **OWNER setup is complete**, superseding the pre-bootstrap snapshot below. Do not bootstrap again. Additional staff setup and owner recovery rehearsal remain unconfirmed.
- **Counter menu import succeeded**, owner-verified: 15 categories, 118 dishes, 156 priced/available Counter variants and 133 menu audit records. The original empty/pre-bootstrap backup is not evidence that today's restaurant data has been backed up.
- **Platform menu enablement is prepared/tested locally; production apply is unconfirmed.** Last reported platform state: zero SWIGGY and zero ZOMATO settings, all three channels active. Use the separate [platform runbook](PLATFORM_MENU.md); do not rerun the seed. Expected first apply adds 312 settings and 118 audits, but these are expected results, not observed production counts.
- **Maintenance TEMPORARY privilege was revoked**, per the owner. Platform SQL requires no temporary objects; do not regrant it.
- **Deployed release last verified:** `fdef4f7b41d6a26bb88ef29d30e5e9ec640d70f7`. Later source commits and standalone SQL deliveries do not mean `/opt/dukanos/current` was upgraded. Verify the release before any future deployment.
- HTTPS, backup encryption/upload, laptop decryption and isolated database recovery passed in the supplied handover. Monitoring/notification delivery, first scheduled backup result/downtime, reboot drill, real-device pilot and full replacement-host recovery remain **pending confirmation**.
- Exact EC2 instance type is unknown; approximately 2 GiB RAM does not identify it. SMTP configuration, production tax settings and billing guardrails remain unconfirmed.

Start with monitoring and verification planning, not another OWNER bootstrap or menu import. No live action is authorized by this context document. The owner executes the reviewed one-time menu commands personally. Repository implementation procedures are in [DEPLOYMENT.md](../DEPLOYMENT.md); historical preparation checks are in [the preparation checkpoint](../checkpoints/aws-pilot-preparation.md).

## Owner inventory update — 17 October 2026

The owner now reports 468 menu channel settings and 251 menu audits, superseding the earlier unconfirmed platform-apply state. Menu remains 15 categories / 118 dishes / 156 variants. An encrypted October 17 backup was created and its S3 object verified, per the owner; scheduled-run/alert delivery and complete replacement-host recovery are still unconfirmed.

Seven October 17 test orders (five Counter, two Zomato), five bills, four collections totaling ₹1,100 and related operational rows were supplied for an independent cleanup review. Seven historical daily reports (October 10–16) and daily number counters must remain. See the [cleanup safety review](TEST_ORDER_CLEANUP_2026-10-17.md). Scripts are prepared/tested locally only; **cleanup has not been executed or authorized for production by this review**. Never assume these counts are current without checking during the separately approved maintenance window.

## Owner baseline correction — 18 October 2026

Read-only production inspection reports **293 menu audits** (133 CREATED, 160 UPDATED), superseding the earlier 251 count. Counts for the seven orders/five bills/four payments/nine lines/thirteen histories/one timer/seven reports and Menu inventory were unchanged at inspection. All nine guards were enabled; disabled triggers and unvalidated FKs were zero. The schema digest matched `6b9ec2c9e9afb656f13677f85606a61ef6a7d0b691edd2d21c2b0c44eca16f72`. The owner restored the app after inspection; cleanup dry run was **not executed**. See the corrected [cleanup runbook](TEST_ORDER_CLEANUP_2026-10-17.md). These are owner-provided observations, not new agent production access; worker activity after restart may invalidate the dated inventory.

## Original dated handover evidence

The following sections describe the 12 October snapshot. Any pre-bootstrap or unconfigured-menu statements are historical and superseded by the reconciliation above. Commands are operator references, not instructions to execute automatically.

## 1. At-a-glance state

| Area                         | State at snapshot                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Cloud app                    | **Running**: `https://rudragiri-velvase.duckdns.org`                                                     |
| Public HTTPS readiness       | **PASS**: `{"status":"ok","service":"dukanos-api"}`                                                      |
| AWS location                 | **Mumbai** / `ap-south-1`; account `645822828303`                                                        |
| Compute                      | Single EC2 Ubuntu 24.04 x86_64; instance `i-04f0a6cd86717bc7f`                                           |
| Public networking            | Elastic IP **`13.233.74.152`**, DuckDNS points to it                                                     |
| Database                     | PostgreSQL 16.15 on **same EC2**, loopback only; `dukanos_prod`, schema `dukanos`                        |
| DB deployment                | **21 migrations (001–021)** applied; **no production OWNER/staff bootstrap yet**                         |
| Off-host backups             | **PASS**: encrypted S3 upload, integrity verification, laptop decryption and isolated PostgreSQL restore |
| Scheduled backups            | `dukanos-backup.timer` **enabled + active**, daily **05:15 IST** (`23:45 UTC`)                           |
| S3 lifecycle                 | **Created**, prefix `production/`, current objects expire at 90 days, noncurrent versions after 7 days   |
| Alerts / monitoring          | **PENDING**: no SNS/CloudWatch alert chain confirmed created                                             |
| Shop hardware and live pilot | **NOT YET TESTED** on actual cashier/kitchen/dispatch devices                                            |

### Architecture / flow

```text
Shop tablet / mobile / browser
      | HTTPS 443 (requires shop internet)
      v
DuckDNS rudragiri-velvase.duckdns.org -> Elastic IP 13.233.74.152
      |
      v
AWS EC2, Mumbai (Ubuntu 24.04)
  Nginx :443 / TLS (Let's Encrypt)
      |  localhost :3000
      v
  systemd dukanos.service -> one Node 24 / NestJS API + React built assets
      |                         + background daily workers
      +---- localhost PostgreSQL 16 / dukanos_prod
      +---- /var/lib/dukanos/uploads/{menu,expenses}

05:15 IST systemd timer -> STOP app -> pg_dump + uploads + config + release
    -> GPG encrypt (public key on EC2) -> private S3 /production/
    -> write last-success.json -> START app
Recovery: encrypted S3 bundle -> laptop -> private GPG key -> isolated PG16 restore
```

**Architecture constraints:** No RDS, ALB, CDN, Route 53, Redis, Kafka, Kubernetes, or extra frontend host. No direct public API port 3000 or database port 5432. Cloud-only mode **cannot accept new orders if the shop loses internet**: there is no offline-browser write queue or automatic LAN/cloud sync. Never run a standalone local database and AWS as two writable order authorities without designing synchronization first.

## 2. Machine, networking and versions

| Item           | Config / verified detail                                                                       | Where to inspect                                                   |
| -------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Region         | `ap-south-1` (Mumbai)                                                                          | AWS region selector                                                |
| EC2 ID         | `i-04f0a6cd86717bc7f`                                                                          | EC2 > Instances                                                    |
| OS/arch        | Ubuntu **24.04**, **x86_64**                                                                   | `cat /etc/os-release; uname -m`                                    |
| Sizing         | Approx. **2 GiB RAM**; actual EC2 instance **type not captured** in handover                   | EC2 > Instance details; `free -h; nproc`                           |
| Root disk      | **40 GiB encrypted gp3 EBS**                                                                   | EC2 > Volumes; `lsblk; df -h`                                      |
| Swap           | **2 GiB** configured                                                                           | `swapon --show; free -h`                                           |
| Public address | Elastic IP `13.233.74.152` (earlier ephemeral `43.204.233.118` is obsolete)                    | EC2 > Elastic IPs                                                  |
| DNS            | `rudragiri-velvase.duckdns.org` -> Elastic IP                                                  | DuckDNS owner portal; `getent hosts rudragiri-velvase.duckdns.org` |
| Firewall       | SSH/22 restricted to owner's public IP; HTTP/80 and HTTPS/443 public; 3000/5432 **not public** | EC2 > Security Groups, plus host rules                             |
| Node           | **v24.21.0**                                                                                   | `node --version`                                                   |
| npm            | **11.19.0**                                                                                    | `npm --version`                                                    |
| PostgreSQL     | **16.15**                                                                                      | `psql --version; systemctl status postgresql`                      |
| Nginx          | Ubuntu **1.24**                                                                                | `nginx -v; sudo nginx -t`                                          |
| Certbot        | **2.9.0**                                                                                      | `certbot --version; systemctl list-timers '*certbot*'`             |
| AWS CLI        | v2 **2.37.12**, `/usr/local/bin/aws`                                                           | `aws --version; command -v aws`                                    |
| Node API       | Loopback `127.0.0.1:3000`                                                                      | `sudo ss -ltnp`                                                    |

**Laptop -> EC2 login** (execute on the owner's Ubuntu laptop, **not on EC2**):

```bash
ssh -i ~/Downloads/DukanOs_EC2.pem ubuntu@13.233.74.152
```

The laptop SSH private key is `~/Downloads/DukanOs_EC2.pem`; **do not share its contents or commit it**. EC2 shell prompt resembles `ubuntu@ip-172-31-1-66:~$`, laptop prompt resembles `current_user manish-pandey ... =>`. EC2 SSH security group may need an IP-rule update if the owner's home/mobile IP changes; prefer minimally restricted access.

## 3. Deployment and source-control locations

| Location                                   | Purpose / control                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Private GitHub repo `manishmaang/DukanOs`  | Source of application, migrations, scripts, docs; **no secrets in Git**                                     |
| Deployed commit                            | `fdef4f7b41d6a26bb88ef29d30e5e9ec640d70f7` (**pin as deployed snapshot; don't assume latest main matches**) |
| `/opt/dukanos/releases/fdef4f7`            | Built release, root-controlled/read-only to application user                                                |
| `/opt/dukanos/current`                     | Symlink to deployed release; systemd working directory                                                      |
| `/opt/dukanos/current/apps/api`            | NestJS API and compiled `dist`                                                                              |
| `/opt/dukanos/current/apps/web/dist`       | Compiled React UI (served by API)                                                                           |
| `/opt/dukanos/current/database/migrations` | SQL files, `001` through `021` applied                                                                      |
| `/opt/dukanos/current/scripts`             | Bootstrap, migration, provisioning, backup, monitor and release tools                                       |
| `/opt/dukanos/current/deploy`              | Service, timer and Nginx templates                                                                          |
| `~ubuntu/.ssh/dukanos_github`              | **Private read-only GitHub deploy key** on EC2; never print/copy content                                    |
| `~ubuntu/.ssh/dukanos_github.pub`          | Matching **public** deploy key registered in repo > Settings > Deploy keys (read-only)                      |
| Repo instructions                          | `AGENTS.md`, `README.md`, `docs/SYSTEM.md`, `docs/DEPLOYMENT.md`, `docs/PRODUCTION_READINESS_AUDIT.md`      |

**Verified at deployment:** private repo clone via deploy key, `npm ci`, build, unit/typed checks and service start succeeded; npm audit had **0 reported vulnerabilities at that time**. Re-check when deploying upgrades. Production is **not** a Vite dev server. Do not run `npm run db:migrate` from a `.env` pointing to the wrong DB; production has separate protected credentials. Do not edit an applied migration.

## 4. Runtime service, data, DB and secrets — where things live

| Exact path / name                                         | Purpose                                                                     | Access rules                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `dukanos.service` (`/etc/systemd/system/dukanos.service`) | Runs Node/NestJS, React assets and background workers; `Restart=on-failure` | `sudo systemctl status dukanos.service`                                          |
| `dukanos`                                                 | Non-root OS service account                                                 | Application files read-only, only data dir writable                              |
| `/etc/dukanos/`                                           | Protected production configuration directory                                | `root:root`, mode **0700**; **never paste contents**                             |
| `/etc/dukanos/runtime.env`                                | Runtime role, production environment and app config                         | `root:root`, **0600**; **contains password**                                     |
| `/etc/dukanos/maintenance.env`                            | Migrator credentials for controlled migrations/backups/bootstrap            | `root:root`, **0600**; **contains password**                                     |
| `/etc/dukanos/backup.env`                                 | Maintenance DB URL + S3 prefix + GPG public fingerprint + backup paths      | `root:root`, **0600**; **contains password**                                     |
| `/var/lib/dukanos/uploads/menu`                           | Persistent menu photographs                                                 | OS user `dukanos`, restricted                                                    |
| `/var/lib/dukanos/uploads/expenses`                       | Persistent expense receipts                                                 | OS user `dukanos`, restricted                                                    |
| `/var/backups/dukanos/`                                   | Locally staged encrypted backups and success marker                         | `root:root`, **0700**                                                            |
| `/var/backups/dukanos/last-success.json`                  | Latest successful encrypted **offsite** transfer time/artifact name         | Safe to inspect after reviewing output for secrets; contains no DB URL by design |
| DB `dukanos_prod`; schema `dukanos`                       | PostgreSQL 16, localhost only                                               | No public DB endpoint                                                            |
| DB login `dukanos_migrator`                               | Schema owner; migrations + backup `pg_dump`                                 | Maintenance only                                                                 |
| DB login `dukanos_app`                                    | Restricted application DML/function grants, not schema owner                | App runtime only                                                                 |

**Environment baseline:** `NODE_ENV=production`, Node listens on `127.0.0.1:3000`, data at `/var/lib/dukanos`, timezone `Asia/Kolkata`, previous-business-day cleanup gate **05:00 IST**. Schema migration ledger `dukanos.schema_migrations`: **21 applied**. A distinct admin/provisioning identity was used in database setup; do not substitute it for runtime. Role capability/isolation checks were performed during setup. **No initial production OWNER / staff created as of 12 Oct 2026** (restore manifest showed zero user-role assignments).

### Read-only operations (on EC2)

```bash
sudo systemctl is-active dukanos.service
sudo systemctl status dukanos.service --no-pager
sudo systemctl status nginx postgresql --no-pager
curl -fsS https://rudragiri-velvase.duckdns.org/api/health/ready
sudo nginx -t
sudo ss -ltnp              # ensure :3000 and :5432 are not public
sudo journalctl -u dukanos.service -n 60 --no-pager
sudo -u postgres psql -d dukanos_prod -Atc 'SELECT count(*) FROM dukanos.schema_migrations;'
readlink -f /opt/dukanos/current
sudo systemctl list-timers dukanos-backup.timer --all
```

Avoid `cat /etc/dukanos/*.env`, `env`, `aws configure`, or commands that print passwords. Do not run schema/integration tests on the production database.

## 5. TLS and HTTP entry point

- Public URL: `https://rudragiri-velvase.duckdns.org`.
- Nginx virtual host: `/etc/nginx/sites-available/dukanos` (enabled via `sites-enabled`). Source template: `deploy/nginx.conf.example`.
- Nginx terminates TLS/HTTPS 443 and reverse-proxies to `127.0.0.1:3000`. HTTP/80 redirects to HTTPS, **except ACME challenge requests**.
- Certificate: Let's Encrypt under `/etc/letsencrypt/live/rudragiri-velvase.duckdns.org/`; observed expiry **2027-01-09**. Check current status with `sudo certbot certificates`.
- Webroot ACME: `/var/www/letsencrypt/.well-known/acme-challenge`. Renewal config: `/etc/letsencrypt/renewal/rudragiri-velvase.duckdns.org.conf` with `authenticator = webroot`, `webroot_path = /var/www/letsencrypt,`.
- Reload hook: `/etc/letsencrypt/renewal-hooks/deploy/dukanos-nginx-reload.sh`; renewal timer enabled.
- Renewal dry-run: **first attempt transient ACME `authorization must be pending`; second attempt PASSED** using `sudo certbot renew --dry-run --cert-name rudragiri-velvase.duckdns.org --run-deploy-hooks`; Nginx and HTTPS readiness remained good.
- Nginx limits request size/login bursts, passes same-origin secure cookies/API headers, and does not expose backend/DB. Any proxy/CloudFront/ALB change requires a new forwarded-header security review.

## 6. Backups, IAM, S3, keys and custody

### AWS resources / policy

| Resource                     | Exact identifier                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Private backup bucket        | `dukanos-backups-mumbai-rudragiri-velvase` (Mumbai)                                                                                                                      |
| Prefix used by backup script | `s3://dukanos-backups-mumbai-rudragiri-velvase/production/` (**trailing slash required**)                                                                                |
| Bucket settings              | Block all public access; bucket-owner enforced ACLs; **Versioning enabled**, **SSE-S3** encryption; S3 Bucket Key disabled                                               |
| IAM instance role            | `DukanOS-EC2-BackupRole` attached to EC2                                                                                                                                 |
| Inline policy                | `DukanOS-S3-Backup-Restricted`                                                                                                                                           |
| Granted S3 scope             | `s3:ListBucket` only for `production/`; `s3:PutObject`, `s3:GetObject`, `s3:AbortMultipartUpload` only for `production/*`; **no DeleteObject**                           |
| S3 retention                 | Lifecycle rule `DukanOS-Production-90Day-Retention`, prefix `production/`, expire current after 90d, noncurrent after 7d; created in console (verify current rule later) |
| Local retention              | `BACKUP_RETENTION_DAYS=14`                                                                                                                                               |

EC2 instance-profile identity was verified using `aws sts get-caller-identity` with ARN `arn:aws:sts::645822828303:assumed-role/DukanOS-EC2-BackupRole/i-04f0a6cd86717bc7f`. No static AWS keys were installed/configured. S3 access tested as normal `ubuntu` and STS as `root`. The sample S3 object `production/dukanos-s3-test.txt` (34 bytes) was deliberately left in S3; it will follow the lifecycle rule.

### Cryptographic custody — especially important

| Key / artifact                            | Location / identifier                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup GPG **primary public fingerprint** | `66AA4115200F42A687265D61C3351B4DD7D82699` (ed25519 sign/certify)                                                                                        |
| GPG encryption **subkey**                 | `3C4055186436B20C6FBE5C49EC131F5627878CA2` (cv25519 encryption)                                                                                          |
| Public armored export (laptop)            | `~/DukanOS-Recovery/dukanos-backup-public.asc`                                                                                                           |
| Public armored copy (EC2)                 | `/home/ubuntu/dukanos-backup-public.asc`                                                                                                                 |
| **Public-only** GPG keyring (EC2)         | `/etc/dukanos/backup-public-keyring` (root restricted)                                                                                                   |
| Private GPG keyring (laptop)              | `~/.local/share/dukanos/backup-gnupg`                                                                                                                    |
| Encrypted private-key export (laptop)     | `~/DukanOS-Recovery/dukanos-private-key.asc.gpg` (AES-256 symmetric encrypted; mode 0600)                                                                |
| Off-device copy                           | Only the **encrypted** private-key export uploaded to user's **private Google Drive**; downloaded copy byte-compared with `GOOGLE_DRIVE_BACKUP_VERIFIED` |
| SSH private key (laptop, separate)        | `~/Downloads/DukanOs_EC2.pem`                                                                                                                            |
| GitHub deploy key (EC2, separate)         | `~ubuntu/.ssh/dukanos_github` (private) and `.pub` (public)                                                                                              |

**Private GPG key is not on EC2 and should stay that way.** EC2 can encrypt but cannot decrypt. The owner knows the private-key export passphrase; it is not in this handover or in S3. The export was tested by decrypting and importing into a temporary keyring; a harmless EC2-generated GPG message was decrypted on the laptop. Do not confuse SSH/GitHub deploy keys with the GPG backup key. Preserve an additional offline recovery copy when convenient; test that the passphrase remains accessible.

### How backup scheduling works

- Unit `/etc/systemd/system/dukanos-backup.service` originates from `deploy/dukanos-backup.service`.
- Timer `/etc/systemd/system/dukanos-backup.timer` originates from `deploy/dukanos-backup.timer`, contains `OnCalendar=*-*-* 23:45:00 UTC` = **05:15 IST**, `Persistent=false`.
- On 12 Oct 2026, `systemctl is-enabled` returned **enabled**, `is-active` returned **active**, and `list-timers` showed next trigger **2026-10-12 23:45 UTC = 13 Oct 05:15 IST**.
- Service invokes `deploy/backup-maintenance.sh`, obtains `flock`, stops `dukanos.service`, invokes `scripts/backup.mjs create` with `/etc/dukanos/backup.env`, then restarts application even on failure (`trap` + unit safeguard).
- Bundle includes **custom-format database dump, uploads, protected configuration, deployed release/dependencies, grant metadata and JSON manifest**; encrypted to GPG public key. AWS CLI uploads `.tar.gpg` and `.sha256` via IAM/SSE-S3. Success is only recorded after offsite upload.
- **Downtime is expected for the entire backup/upload window**. No duration measurement yet. Daily backup can lose up to roughly one day of work in a total server failure; **no point-in-time recovery (PITR)**. Missed runs while powered off are **not auto-caught up**, because `Persistent=false`; overdue-alert checking is essential.

### First known production backup

```text
Date (UTC): 2026-10-12 ~10:36:51
S3 object: production/dukanos-2026-10-12T10-36-51.837Z-d52e190e-4948-4b65-b2d8-3804fba3279e.tar.gpg
Size: 49,482,229 bytes
Checksum: bce33d5b9da1b452bfe6e47f461bc35ef671cb5e24c9f5ae96d665bfea830910
Sidecar: same object key + .sha256 (65 bytes)
Laptop encrypted copy: ~/DukanOS-Recovery/dukanos-2026-10-12T10-36-51.837Z-d52e190e-4948-4b65-b2d8-3804fba3279e.tar.gpg
```

## 7. Commands/tests ACTUALLY run, with results

**This is a factual test log, not a claim that the platform passed realistic concurrent shop traffic.** Several checks were repeated while diagnosing an initial SSH pipe/download hiccup; the final results below passed.

| Check / script                          | Evidence and actual result                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB schema/role hardening during install | Applied migrations `001`–`021`, ledger **21**; separate `dukanos_migrator` / `dukanos_app`; app cannot write migration metadata                                         |
| Deploy                                  | Repo pinned to `fdef4f7`, `npm ci`, `npm run build`, service startup, `npm audit` reported **0** vulnerabilities                                                        |
| HTTPS readiness                         | `curl -fsS https://rudragiri-velvase.duckdns.org/api/health/ready` -> `{"status":"ok","service":"dukanos-api"}`                                                         |
| TLS renewal                             | Certbot webroot `renew --dry-run ... --run-deploy-hooks` **PASSED on second attempt**                                                                                   |
| AWS IAM role                            | `aws sts get-caller-identity` -> assumed role `DukanOS-EC2-BackupRole`                                                                                                  |
| S3 list                                 | `aws s3api list-objects-v2 --bucket ... --prefix production/` -> `KeyCount: 0` before first upload                                                                      |
| S3 upload/download test                 | Wrote sample text; `aws s3 cp ... --sse AES256 --checksum-algorithm SHA256`; downloaded; `cmp -s` -> **`S3_UPLOAD_DOWNLOAD_VERIFIED`**                                  |
| Protected backup config                 | `/etc/dukanos/backup.env` `0600`, `/var/backups/dukanos` `0700` verified using `stat`                                                                                   |
| Backup config/key/IAM                   | **`BACKUP_CONFIG_OK`**, **`BACKUP_PUBLIC_KEY_OK`**, STS root-role ARN valid                                                                                             |
| Manual actual backup                    | `sudo /bin/sh /opt/dukanos/current/deploy/backup-maintenance.sh` -> **`Encrypted full backup and off-instance copy completed.`**                                        |
| Application restart                     | After `sudo systemctl daemon-reload`, service `active` and public readiness returned `ok`                                                                               |
| S3 real artifact                        | Bucket listing showed 49,482,229-byte encrypted bundle and 65-byte checksum sidecar                                                                                     |
| S3 checksum                             | SHA-256 of streamed encrypted object matched sidecar -> **`S3_ENCRYPTED_BACKUP_CHECKSUM_VERIFIED`**                                                                     |
| Laptop downloaded file                  | Size exactly **49,482,229**; local sha256 exactly `bce33d5...a830910` matched S3                                                                                        |
| GPG decryption on laptop                | Decrypted stream listed 6 files; **`BACKUP_DECRYPTION_AND_ARCHIVE_VERIFIED`**                                                                                           |
| PostgreSQL restore                      | Started `postgres:16` Docker at `127.0.0.1:55432`; empty DB confirmed; `pg_restore --exit-on-error --no-owner --no-acl` -> **`DATABASE_RESTORE_COMPLETED`**             |
| Restored inventory                      | Python compared `manifest.json` counts to PostgreSQL: **39 tables**, **21 migrations**, all row counts match                                                            |
| Financial reconciliation                | Compared sums of effective food sales, Cash/UPI collections, refunds and active expenses against manifest -> **`RESTORED_FINANCIAL_TOTALS_VERIFIED`**                   |
| DB structure + staff                    | Compared relation/index/view/sequence/function/trigger/constraint catalog and application user roles -> **490 objects**, **0 user-role assignments**, matching manifest |
| Remaining bundle files                  | SHA-256 all 5 manifest components + `tar -tzf` all 3 compressed files -> **`FULL_BACKUP_COMPONENT_INTEGRITY_VERIFIED`**                                                 |
| Restore cleanup                         | Removed temporary Docker PG16 container, extracted plaintext recovery files and temporary DB credentials -> **`RECOVERY_TEST_CLEANUP_COMPLETED`**                       |
| Backup timer                            | Installed, `systemd-analyze verify` passed, enabled + active at **05:15 IST** daily                                                                                     |
| S3 lifecycle                            | User created `DukanOS-Production-90Day-Retention`, 90-day current/7-day noncurrent rules for `production/`                                                              |

### Compact reproduction / audit commands

**EC2 public readiness and scheduled backup (read-only):**

```bash
sudo systemctl is-active dukanos.service
curl -fsS https://rudragiri-velvase.duckdns.org/api/health/ready
systemctl list-timers dukanos-backup.timer --all
sudo systemctl status dukanos-backup.service --no-pager
sudo journalctl -u dukanos-backup.service -n 50 --no-pager
sudo stat -c '%A %U:%G %n' /etc/dukanos/backup.env /var/backups/dukanos
sudo cat /var/backups/dukanos/last-success.json
aws s3 ls s3://dukanos-backups-mumbai-rudragiri-velvase/production/ --region ap-south-1
```

**Exact checksum of known encrypted S3 backup, without plaintext** (EC2; read-only):

```bash
BUCKET=dukanos-backups-mumbai-rudragiri-velvase
KEY=production/dukanos-2026-10-12T10-36-51.837Z-d52e190e-4948-4b65-b2d8-3804fba3279e.tar.gpg
EXPECTED=$(aws s3 cp "s3://$BUCKET/$KEY.sha256" - --only-show-errors | tr -d '\r\n')
ACTUAL=$(aws s3 cp "s3://$BUCKET/$KEY" - --only-show-errors | sha256sum | cut -d' ' -f1)
[ "$ACTUAL" = "$EXPECTED" ] && echo S3_ENCRYPTED_BACKUP_CHECKSUM_VERIFIED
```

**Known laptop encrypted file hash and GPG stream test** (laptop only; passphrase stays local):

```bash
FILE="$HOME/DukanOS-Recovery/dukanos-2026-10-12T10-36-51.837Z-d52e190e-4948-4b65-b2d8-3804fba3279e.tar.gpg"
sha256sum "$FILE"  # bce33d5b9da1b452bfe6e47f461bc35ef671cb5e24c9f5ae96d665bfea830910
gpg --homedir "$HOME/.local/share/dukanos/backup-gnupg" --decrypt "$FILE" | tar -tf -
# Listed: configuration.tar.gz, database.dump, grants.json, media.tar.gz, release.tar.gz, manifest.json
```

**How isolated PostgreSQL recovery was tested** (history; **don't blindly rerun**, especially not against production):

1. On laptop, generated a restricted random password file `~/.local/share/dukanos/restore-db.env`; started Docker `postgres:16` as `dukanos-restore-pg16`, DB `dukanos_restore_verify`, exposed **only** `127.0.0.1:55432`.
2. Checked readiness via `docker exec ... pg_isready` and confirmed table count **0**.
3. Locally decrypted the S3 bundle (laptop-only GPG private key), extracted `database.dump` + `manifest.json` under restricted `~/DukanOS-Recovery/restore-check`; verified dump SHA-256 against manifest.
4. Used `docker cp` and `docker exec dukanos-restore-pg16 pg_restore --exit-on-error --no-owner --no-acl --username=dukanos_restore --dbname=dukanos_restore_verify /tmp/dukanos-restore-database.dump`.
5. Read-only Python + SQL compared restored table lists/counts, `dukanos.schema_migrations` names/checksums, food/collection/refund/expense sums, detailed PostgreSQL object inventory and user-role mapping with `manifest.inventory` (39 / 21 / 490 / 0; all match).
6. Decrypted the remaining component archives and matched all five checksums; verified gzip/tar readability; removed the disposable database and plaintext extracts. **Only the encrypted original backup and GPG recovery material remain on the laptop.**

**Observed harmless hiccups:** A first laptop-download script was accidentally executed **on EC2** and failed because `/home/ubuntu/Downloads/DukanOs_EC2.pem` does not exist; subsequent laptop SSH passed. Two piped laptop checksum-fetch scripts returned without a verification message, but the standalone S3 checksum fetch and laptop `sha256sum` both returned the identical expected hash. Systemd warned about changed unit files during manual backup; `sudo systemctl daemon-reload` cleared the issue and services remained active.

## 8. Where to look when someone asks about X

| Question                                  | Read this first                                                                                    | Safe check / next step                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| What's deployed?                          | This file; `/opt/dukanos/current`, `AGENTS.md`, `docs/SYSTEM.md`                                   | `readlink -f /opt/dukanos/current`; `git -C /opt/dukanos/current rev-parse HEAD`                      |
| Is the website/API online?                | Nginx config + `dukanos.service`                                                                   | `curl -fsS https://rudragiri-velvase.duckdns.org/api/health/ready`; `systemctl status`                |
| Why is HTTPS failing?                     | `/etc/nginx/sites-available/dukanos`; Certbot renewal config                                       | `sudo nginx -t; sudo certbot certificates; sudo journalctl -u nginx`                                  |
| Why can't I SSH?                          | EC2 instance state, `13.233.74.152`, security-group SSH source                                     | Verify laptop public IP allowed on port 22; key at `~/Downloads/DukanOs_EC2.pem`                      |
| DB schema, permissions, migrations?       | `docs/DATABASE.md`, `scripts/migrate.mjs`, `scripts/provision-database.mjs`, `database/migrations` | Count `dukanos.schema_migrations` via local Postgres; don't print env URLs                            |
| Where are uploaded images?                | `docs/DEPLOYMENT.md`; media module docs                                                            | `/var/lib/dukanos/uploads/menu` and `/expenses`, **not release directories**                          |
| How are bills/orders/payments handled?    | `docs/SYSTEM.md`, relevant `docs/modules/`, actual API code                                        | Trace API endpoints and schema; never modify past payments manually                                   |
| Where is the backup?                      | `scripts/backup.mjs`; `deploy/backup-maintenance.sh`                                               | S3 `production/`, local `/var/backups/dukanos`, `last-success.json`                                   |
| Where are the backup/public/private keys? | Section 6 above                                                                                    | Only GPG public on EC2; encrypted GPG private-key export + GPG keyring on laptop                      |
| Why did a scheduled backup fail?          | `dukanos-backup.service`, `backup.env` (protected)                                                 | `sudo systemctl status dukanos-backup.service; sudo journalctl -u dukanos-backup.service -n 100`      |
| Which AWS permissions exist?              | IAM role `DukanOS-EC2-BackupRole` + inline policy                                                  | `aws sts get-caller-identity`; IAM console; don't attach S3FullAccess                                 |
| Why did costs increase?                   | AWS Billing/Cost Explorer/Budgets                                                                  | Check EC2 compute, EBS, **public IPv4**, S3 storage/versioning, data transfer, monitoring             |
| How to recover the owner login?           | `README.md`, `scripts/reset-owner.cjs`, `docs/DEPLOYMENT.md`                                       | Needs controlled loopback Postgres access; do not improvise public reset endpoint                     |
| How to deploy an update?                  | `docs/DEPLOYMENT.md`, `AGENTS.md`, decision/change logs                                            | New branch, tests, reviewed commit, **backup + downtime permission**, migration/grant/release process |
| How to assess monitoring?                 | `scripts/monitor.mjs`, repo deployment monitoring docs                                             | **Not installed/configured end-to-end yet**; verify unit names before creating them                   |

## 9. Security/operating rules for Codex and future sessions

1. **Never disclose** contents of `/etc/dukanos/*.env`, SSH PEM/deploy private keys, GPG private key/passphrase, database URLs with embedded credentials, cookies, financial records or unredacted logs. Paths/public-key fingerprints are okay to document in this private handover.
2. **Do not push this operations handover to a public repository.** If checked into the private DukanOS repo, review what infrastructure identifiers should remain internal. Do not put any secret contents here.
3. **Read required context first** per `AGENTS.md`, inspect implemented code, create a **new branch for each feature**, update the affected module/changelog/checkpoint docs, and report tests and the deployed vs current repo commit explicitly.
4. **Don't deploy automatically:** no live SQL migrations, database cleanup, owner bootstrap, service interruption, IAM/S3 policy edits or DNS changes without owner approval and a reviewed maintenance plan. Update a live release **only** via controlled versioned release workflow.
5. Production migrations require `dukanos_migrator`, then refreshed explicit runtime grants; runtime `dukanos_app` must not own schema or receive migration rights. Don't seed or overwrite data.
6. Never restore an older snapshot onto live DB while live POS remains writable. A restore may lose newer orders, receipts, payment keys and delivery history. Reconcile external cash/UPI and order state first; plan credentials/grants and media recovery.
7. A passing database restore is **not** a complete replacement EC2 restore or concurrent-load certification. Treat the machine as a single point of failure until fuller recovery is rehearsed.

## 10. Remaining work (prioritized for actual-shop testing)

### Before a real-payment/customer pilot — high priority

- [ ] **Finish alert delivery:** create SNS Standard topic `DukanOS-Backup-Alerts` (not created yet), subscribe/confirm owner's email; build a _tested_ CloudWatch/instance or equivalent alert for **backup failure AND backup not happening** (check offsite `last-success.json`/S3 age, not just service exit).
- [ ] **Health monitoring:** install/adapt `scripts/monitor.mjs` to checked production configuration and a scheduler; persistent bounded journal/logs; actionable service/backup/disk alerts. Verify exact repository unit filenames; don't assume templates are already installed.
- [ ] **Independent host-down detection:** EC2 status alarms / external HTTPS uptime checks; in-guest checks cannot alert when EC2 is off.
- [ ] **EC2 reboot drill:** deliberate approved reboot, check PostgreSQL/Nginx/NestJS/DNS/HTTPS/backups come back; test recovery from a failed process or DB outage, without live customer orders.
- [ ] **Verify first scheduled backup** after **13 Oct 2026 at 05:15 IST**, upload and health after restart; confirm downtime duration. Configure missed-backup alert because `Persistent=false`.
- [ ] **AWS spending guardrails:** AWS Budgets / billing alarms, spend and credits monitoring; check public IPv4/S3/versioning/EC2/EBS cost and storage capacity.
- [ ] **Production initial OWNER bootstrap** (no default users). Script is `scripts/bootstrap-owner.cjs`; requires stdin JSON `username`, `name`, `password` and an appropriately scoped _production_ DB connection. Don't blindly use `npm run auth:bootstrap` because its root script reads development `.env`. Review process with Codex and owner before executing.
- [ ] **Real shop configuration:** menu, portions/prices/availability, Zomato/Swiggy Normal/Less operational settings (where relevant), user roles/staff accounts and permissions; verify correct bill/date/tax/business settings.
- [ ] **Real-device acceptance:** simultaneous POS -> Kitchen FIFO -> Dispatch -> Bills/Payments, additional rounds, amendments/refunds, item images, reconnection and audio, session cookies, touch layouts and printer workflow; measure peak-time CPU/RAM/disk/latency on ~2 GiB host. No target-host load certificate exists yet.
- [ ] **Operational fallback:** reliable shop Wi-Fi plus cellular backup and a documented manual process when WAN/AWS is unreachable. Cloud-only cannot fulfill original offline-order requirement.

### Important later / before full reliance

- [ ] **Rehearse complete AWS-host replacement** (provisioning, roles/grants with fresh credentials, decrypted app/media/config, HTTPS/DNS flip and transaction reconciliation); laptop DB restore alone isn't that.
- [ ] **Owner password-recovery rehearsal** using reviewed `scripts/reset-owner.cjs`, controlled loopback access and a noncustomer window.
- [ ] **Backup-policy review:** choose acceptable recovery-point objective (daily backup may lose almost 24 hours), observe backup downtime, consider PITR strategy if needed, regularly restore-check new backups, verify S3 lifecycle and key custody.
- [ ] **Printer feature**: repository snapshot explicitly says printing is **not implemented**; design/test thermal token/receipt printing before relying on paper output. It is not an AWS configuration switch.
- [ ] Optional SMTP/report email setup; not required for basic POS and should be tested deliberately.
- [ ] Security updates, monitoring of disk/inodes, certificate renewal beyond first dry-run, release/rollback procedure and operational runbook improvements.

**Suggested continuation point:** Resume **Step 55.1**: SNS topic + email confirmation; then connect a low-cost alarm that detects both failed and **missing** backups. Keep the already created S3 bucket/policies and working release unchanged. After monitoring and reboot verification, bootstrap OWNER and move to a **controlled dummy-order shop trial**, not unguarded live transactions.

---

**Evidence distinction:** All successful check outputs above came from this supervised session as supplied by the owner. Bucket lifecycle creation was confirmed by the owner in the AWS console, not independently queried by API here. Instance type, exact EC2 monthly cost, real-world order throughput, thermal printing and full-host recovery have **not** been verified. Recheck the live state before using this historical handover to make changes.
