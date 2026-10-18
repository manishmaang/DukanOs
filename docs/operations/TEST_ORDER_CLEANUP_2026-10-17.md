# October 17 test-data cleanup — final October 18 revision

## Scope and authorization

This replaces the obsolete 7-report/13-history/no-cancellation cleanup reviewed at `178d19b` and the audit-count correction merged at `16b1726`. The owner reports normal overnight processing has now produced five cancellations and October 17 report v1. All seven orders and four collections are confirmed test-only, with no real customer money. This is an exceptional administrative deletion, never an application feature or normal financial correction.

**Preparation only. No AWS connection, production inspection, transfer, service operation or SQL execution was performed by the agent.** The owner separately authorizes transfer, read-only inspection, downtime, rehearsal and commit. A previous backup is not proof of present recoverability: obtain a fresh encrypted coordinated backup and verify recovery-key availability before maintenance.

Files:

- [Cleanup SQL](../../scripts/cleanup-test-orders-2026-10-17.sql)
- [Read-only verification SQL](../../scripts/verify-test-order-cleanup-2026-10-17.sql)
- [Isolated tests](../../scripts/test-test-order-cleanup.cjs)
- [Final October 18 evidence](evidence/test-order-cleanup-2026-10-18-final.txt)

## Exact deletion and preservation

| Group                                        | Delete | Required baseline / retained records                                                                                                  |
| -------------------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------- |
| orders                                       |      7 | Exact seven UUIDs below; October 17; 5 COUNTER / 2 ZOMATO; 2 COMPLETED / 5 CANCELLED                                                  |
| bills                                        |      5 | Five distinct Counter parents, DINE_IN, October 17, numbers 1–5                                                                       |
| payments                                     |      4 | COLLECTION only: one CASH ₹280, three UPI totaling ₹820; total ₹1,100                                                                 |
| order_items                                  |      9 | Original lines belonging to target orders                                                                                             |
| order_status_history                         |     18 | Original 13 October 17 events plus five October 18 system cancellations                                                               |
| order_amendments                             |      3 | Exactly one revision-1 system CANCEL per cancelled Counter order, zero totals                                                         |
| platform_order_cancellations                 |      2 | Exactly one system cancellation per cancelled Zomato order                                                                            |
| kitchen_timers                               |      1 | Exact acknowledged order-only timer below                                                                                             |
| daily_reports                                |      1 | Exact UUID discovered for October 17 v1 AUTOMATIC; generated October 18; no deliveries                                                |
| daily_reports retained                       |      0 | Seven October 10–16 reports, all columns/JSONB unchanged                                                                              |
| order_daily_tokens / bill_daily_numbers      |      0 | Sole October 17 rows: last_token=7 / last_number=5                                                                                    |
| menu_categories / menu_items / item_variants |      0 | 15 / 118 / 156, every field unchanged                                                                                                 |
| variant_channel_settings / menu_audit        |      0 | 468 / 293, every field unchanged                                                                                                      |
| All other tables                             |      0 | Exact before/after equality, including users/sessions/roles, settings/cursor/audits, expenses/receipts, metadata and migration ledger |

Exact order UUIDs (not selected merely by date):

```text
f6cca944-a322-4f3a-a021-a21b2bc7c7fc
87776115-adf3-4ec9-a62e-829374a47ede
1dd1fb53-a551-47a7-8109-85fe889d4441
4d2bb443-edc1-46de-9da1-b2d21e730456
3d499b63-c885-425f-ac2a-21cb2c06df46
f29f9147-4929-48f7-ae4a-009891fc7ea9
f70effcb-5a1e-4cfe-9bb1-ae5b1a52715d
```

Timer `273e996f-81c6-45bd-8bd8-95f836bc3722` belongs to `87776115-adf3-4ec9-a62e-829374a47ede`, token #2, with no order_item_id and ACKNOWLEDGED status. Amendment/report UUIDs are not fabricated. Read-only inventory exposes them; cleanup derives them from strict relationships and binds all row contents to the reviewed fingerprint. Apply additionally requires the separately reviewed report UUID.

The three amendments must match cancelled Counter orders and rollover-closed Bills, retain original before_total, revision 1, empty note, null system actor and zero final totals. Both platform rows must match the two cancelled Zomato orders. All five cancellations require `PREVIOUS_BUSINESS_DAY_AUTO_CANCEL`, Asia/Kolkata, configured cutoff `05:00`, October 18 timestamp at/after 05:00, and matching history timestamp; each cancelled order has initial QUEUED plus CANCELLED history. Each completed order has four lifecycle events. A different actual configuration or relationship stops for review; do not adjust it merely to pass.

## Dependency and trigger analysis

Reviewed migrations 001–021 and actual rollover/cancellation/report workers. No migrations or runtime changes are introduced.

- Payments reference Bills and optional confirmation Orders. Timers reference Orders and optional composite Order/line identity. Remove timer and payments before parents.
- Amendment headers reference Orders and Bills; revision lines reference both headers and original lines. Revision population must be empty and its protection stays enabled. Remove only captured amendment IDs, then scoped platform cancellations, before Orders/Bills. Their deferred INSERT validators do not run on DELETE.
- History and original items reference Orders; Orders reference Bills, users and sales channels; original items reference menu entities. Remove history/items before Orders, then Bills. These restrictive FKs never permit deletion to cascade into menu or staff.
- Reminders must be empty. Reminder synchronization triggers are INSERT-only on payments/orders/amendments and UPDATE-only on Bills, not DELETE. No reminder job or financial compensation is invoked.
- Reports contain JSON snapshots rather than order FKs. Deliveries reference reports; attempts/actions reference deliveries. **Any delivery/attempt/action anywhere aborts this baseline.** None is deleted. Incoming references from other schemas also abort. Preserved snapshots containing target order/Bill UUIDs abort.
- `effective_orders`, `effective_order_items`, `bill_balances` are ordinary views. They become empty for deleted test activity; no view rebuild or report regeneration occurs in cleanup.
- Minimum nine guards disabled/restored inside the transaction: `immutable_kitchen_timer`, `protect_payments`, `protect_amendments`, `protect_platform_cancellation`, `daily_reports_immutable`, `immutable_order_history`, `immutable_order_items`, `immutable_orders`, `protect_bills`. `protect_revision_items`, report delivery/settings/attempt/action guards and **every FK trigger remain enabled**. The verification lists ten relevant guards, including the unchanged revision guard. There is no CASCADE, TRUNCATE, broad trigger disabling or replication-role bypass in cleanup.
- Deletion order: timer → payments → amendments → platform cancellations → exact report → history → items → orders → Bills. Every stage checks exact affected count. Trigger restoration, immediate constraints, schema equality and full preserved-row comparison precede COMMIT/ROLLBACK. Errors/disconnects roll back both row and trigger changes.
- Menu version/audit and media operations are not invoked. No upload filesystem access. No compensation payment, refund, user revocation or audit reset is fabricated.

## Report-worker analysis and unresolved preflight conditions

`DailyWorkerService.start()` immediately runs rollover, catch-up and optional delivery; HTTP startup also awaits `BillRolloverService.start()`. Catch-up initializes a null `start_date` to yesterday, then generates from persisted `next_date`, advancing one day after successful generation. Email OFF does **not** disable stored report generation. Existing v1 prevents duplicate generation only while it exists.

Therefore cleanup requires initialized `start_date <= 2026-10-17` and **`next_date = 2026-10-18`**. A null/earlier/later cursor aborts; neither SQL nor runbook changes it. Current production cursor was not supplied and must be independently verified. With this cursor, October 18 restart does not examine October 17. October 19 catch-up generates October 18 normally and still never visits October 17. Explicit future manual generation of October 17 remains possible through the unchanged application; do not request it. A future restored/rewound cursor or different deployed worker requires a new review.

Actual application worker/service tests use a private PostgreSQL pool and synthetic clock: at 00:06 the report is generated while five orders remain queued; at 05:01 real system cancellation creates three financial amendments and two platform records without changing the report. After committed cleanup, fresh worker instances run the startup methods and leave the entire database unchanged on October 18; next-day catch-up creates only October 18's zero-activity report. This tests application worker methods, not EC2/systemd/HTTP deployment startup or email delivery.

No production email evidence was accessed. Zero delivery/attempt/action rows establishes no **tracked** send; it cannot prove absence of outside/manual exports or erased external history. The owner must inspect the read-only output and any SMTP/provider/operator evidence available. Any sent, pending, failed, uncertain or external send requires review; deletion cannot retract mail. Apply requires `external_sends_checked=true` to attest that review found no external sends. Do not set it while uncertain.

Other blockers: fresh recoverable backup; exact still-test-only inventory; no new legitimate activity; actual schema matching known-good digest; actual deployed worker matching the inspected implementation. Do not silently accept schema drift or replace the expected digest. Prior reported schema SHA-256:

```text
6b9ec2c9e9afb656f13677f85606a61ef6a7d0b691edd2d21c2b0c44eca16f72
```

## Transaction and repeat behavior

PostgreSQL 16, exact `dukanos_prod`/`dukanos`, both session/current identity `postgres`, normal trigger mode. Holds migration/restaurant/report advisory locks 742019321/323/324, and all application tables in deterministic ACCESS EXCLUSIVE order. Rejects other clients, enabled event triggers, disabled triggers, external incoming FKs, schema/ledger drift and any unexpected inventory. All 21 migration checksums remain fixed. No TEMPORARY privilege is required.

All table values are captured internally with UTC/ISO/C-collation canonical ordering. Sensitive values never leave SQL; only hashes and explicit maintenance metadata are printed. Default run executes all deletions and checks then ROLLBACK. Commit requires exact phrase, report UUID, external-send attestation and the real successful production dry-run fingerprint. Any changed row between review and apply aborts. Unaffected tables compare exactly; daily_reports compares exactly to its before set minus only the captured UUID.

Repeat execution refuses safely; it is not a general reset/no-op. Keep secure evidence. If COMMIT result is ambiguous, inspect the actual database first; do not automatically repeat or restore a backup. Counters remain 7/5 (next October 17 numbers would be #8/#6); a new date follows normal independent numbering. Close old POS tabs/discard pending retries because deleted idempotency keys could otherwise allow an old request to be resubmitted after restart.

## Local tests

Development laptop only, never EC2:

```bash
npm run build -w @dukanos/api
node scripts/test-test-order-cleanup.cjs
npm run check
```

Harness uses `initdb` PostgreSQL 16 in a random mode-0700 `/tmp/dukanos-cleanup-review-*`, private Unix socket, TCP disabled, its own empty database named `dukanos_prod` solely to exercise the unmodified name gate. All 21 migrations and synthetic data are loaded. Shell clients use clean environments; worker services receive explicit private-socket pools, a synthetic clock and disabled email adapter. No .env, production URL, backup or secret is read. It never instantiates environment-configured DatabaseService or starts an HTTP server. Only its own generated cluster is removed. Build is required to test current compiled worker classes.

Final results and checksums are recorded below. Earlier 27/34-test evidence files are historical and do not certify this expanded scope.

## Owner-only future execution procedure

Each stage requires the owner's separate approval. Commands below were **not executed** by the agent. No application deployment, rebuild, migration or credential change is required.

### A. Transfer and atomic root-owned replacement

After approving final hashes, on laptop:

```bash
sha256sum scripts/cleanup-test-orders-2026-10-17.sql scripts/verify-test-order-cleanup-2026-10-17.sql
scp -i ~/Downloads/DukanOs_EC2.pem scripts/cleanup-test-orders-2026-10-17.sql ubuntu@13.233.74.152:~/cleanup-test-orders-2026-10-17.sql.final-oct18
scp -i ~/Downloads/DukanOs_EC2.pem scripts/verify-test-order-cleanup-2026-10-17.sql ubuntu@13.233.74.152:~/verify-test-order-cleanup-2026-10-17.sql.final-oct18
```

On EC2, compare uploaded hashes with the final reviewed values below, **stop on mismatch**, then stage both as new files and replace each atomically while no maintenance execution is in progress:

```bash
sha256sum ~/cleanup-test-orders-2026-10-17.sql.final-oct18 ~/verify-test-order-cleanup-2026-10-17.sql.final-oct18
sudo install -d -o root -g postgres -m 0750 /var/lib/dukanos-maintenance/2026-10-17-test-cleanup
sudo install -o root -g postgres -m 0640 ~/cleanup-test-orders-2026-10-17.sql.final-oct18 /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup.sql.new
sudo install -o root -g postgres -m 0640 ~/verify-test-order-cleanup-2026-10-17.sql.final-oct18 /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/verify.sql.new
sudo sha256sum /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/*.new
# Only after both new file hashes match the reviewed values:
sudo mv /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup.sql.new /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup-test-orders-2026-10-17.sql
sudo mv /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/verify.sql.new /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/verify-test-order-cleanup-2026-10-17.sql
sudo sha256sum /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/*.sql
```

Do not execute the previously staged obsolete scripts. Transfer/replacement alone does not authorize a dry run.

### B. Approved downtime and read-only baseline

Confirm fresh encrypted recoverable backup/recovery key, test-only data, no real payments, no new transactions and no external report sends. Close operational tabs/discard retries, obtain downtime and stop other DB tools/jobs. Record release using `git -C /opt/dukanos/current rev-parse HEAD`; latest local main does not prove deployed code.

Use one root shell, holding the backup wrapper's existing lock. Do not interrupt an active backup. Record original states before stopping anything; save this record securely for shell-disconnection recovery.

```bash
sudo -i
umask 077
exec 9>/run/lock/dukanos-backup.lock
flock -n 9 || { echo 'Maintenance/backup lock busy; stop.'; exit 1; }
if systemctl is-active --quiet dukanos-backup.service; then echo 'Backup active; stop.'; exit 1; fi
cleanup_app_state=$(systemctl is-active dukanos.service || true)
cleanup_backup_timer_state=$(systemctl is-active dukanos-backup.timer || true)
cleanup_monitor_timer_state=$(systemctl is-active dukanos-monitor.timer || true)
install -d -m 0700 /var/log/dukanos-maintenance
printf 'app=%s backup=%s monitor=%s\n' "$cleanup_app_state" "$cleanup_backup_timer_state" "$cleanup_monitor_timer_state" > /var/log/dukanos-maintenance/cleanup-original-states.txt
systemctl stop dukanos-backup.timer
if systemctl is-active --quiet dukanos-backup.service; then echo 'Backup started; stop and investigate.'; exit 1; fi
if [ "$cleanup_monitor_timer_state" = active ]; then systemctl stop dukanos-monitor.timer; fi
systemctl stop dukanos.service
systemctl is-active dukanos.service
# Must be inactive; investigate active/activating/failed/unknown original states.
set -o pipefail
sudo -u postgres env -i PATH=/usr/bin:/bin psql -X -h /var/run/postgresql -U postgres -d dukanos_prod -f /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/verify-test-order-cleanup-2026-10-17.sql 2>&1 | tee /var/log/dukanos-maintenance/cleanup-before.txt
```

Requires OS peer-authenticated `postgres` because named immutability guards need owner authority. No database passwords, maintenance-env printing or runtime-role grants. Keep app stopped and lock FD9 held through post-commit verification. Review exact report/amendment/cancellation IDs and timestamps, all dependencies, absent deliveries/attempts/actions, cursor, counters, schema digest, ten relevant guards `O`, zero disabled/unvalidated constraints and all preserved hashes. Unknown/new rows require another review. No bypass by modifying counts/cursor or inventing a fingerprint.

### C. Separately authorized rollback rehearsal

```bash
sudo -u postgres env -i PATH=/usr/bin:/bin psql -X -h /var/run/postgresql -U postgres -d dukanos_prod -f /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup-test-orders-2026-10-17.sql 2>&1 | tee /var/log/dukanos-maintenance/cleanup-dry-run.txt
```

Require exit status zero, exact nine `CLEANUP_DELETED` counts, `CLEANUP_PRESERVATION_AND_TRIGGER_CHECKS_PASSED`, and `CLEANUP_DRY_RUN_ROLLED_BACK`. Record actual `CLEANUP_TARGET_REPORT_ID` and `CLEANUP_REVIEW_FINGERPRINT`. Run read-only verification again to a distinct secure log; **every** table hash and schema/trigger state must match before. Do not use fixture hashes from test output.

### D. Explicit commit after separate owner decision

Only after reviewed successful rehearsal and confirmation of no tracked/external sends:

```bash
read -r -p 'Reviewed October 17 v1 report UUID: ' cleanup_report_id
read -r -p 'Reviewed production CLEANUP_REVIEW_FINGERPRINT: ' cleanup_fingerprint
sudo -u postgres env -i PATH=/usr/bin:/bin psql -X -h /var/run/postgresql -U postgres -d dukanos_prod \
  -v apply=true \
  -v confirm=DELETE_20261017_TEST_ORDERS_AND_REPORT_V1 \
  -v external_sends_checked=true \
  -v expected_report_id="$cleanup_report_id" \
  -v expected_fingerprint="$cleanup_fingerprint" \
  -f /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup-test-orders-2026-10-17.sql 2>&1 | tee /var/log/dukanos-maintenance/cleanup-apply.txt
```

Require zero exit status and `CLEANUP_COMMITTED`. Errors/timeouts/disconnects are not proof of success; verify actual state before any retry/restore. No permanent marker or audit is fabricated by the cleanup: retain encrypted backup, file hashes and secure operator evidence.

### E. Verify before restart, then restore original states

```bash
sudo -u postgres env -i PATH=/usr/bin:/bin psql -X -h /var/run/postgresql -U postgres -d dukanos_prod -f /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/verify-test-order-cleanup-2026-10-17.sql 2>&1 | tee /var/log/dukanos-maintenance/cleanup-after.txt
```

Require eight fully deleted operational tables empty, exact report UUID absent, total seven October 10–16 reports with the **same preserved-subset digest**. All other table counts/hashes must equal before, including 293 menu audits, settings/cursor, numbering 7/5, users, expenses and migrations. All guards/FKs/schema unchanged. Compare before restart, since legitimate later worker catch-up changes settings/reports.

```bash
if [ "$cleanup_app_state" = active ]; then
  systemctl start dukanos.service
  curl --fail --silent --show-error https://rudragiri-velvase.duckdns.org/api/health/ready
fi
# Inspect sanitized worker success/failure events after startup and at least one 60-second tick.
sudo -u postgres env -i PATH=/usr/bin:/bin psql -X -h /var/run/postgresql -U postgres -d dukanos_prod -c "SELECT business_date,version FROM dukanos.daily_reports ORDER BY business_date,version; SELECT start_date,next_date FROM dukanos.daily_report_settings; SELECT count(*) AS forbidden_test_day_reports FROM dukanos.daily_reports WHERE business_date='2026-10-17';"
# forbidden_test_day_reports must be 0. Investigate any worker error or recreation.
if [ "$cleanup_backup_timer_state" = active ]; then systemctl start dukanos-backup.timer; fi
if [ "$cleanup_monitor_timer_state" = active ]; then systemctl start dukanos-monitor.timer; fi
flock -u 9
exit
```

If originally inactive, leave application inactive; a later start is separately authorized and needs the same worker check. Failure: retain downtime until rollback/data/trigger state is verified, recover original-state log if shell disconnected, and deliberately restore appropriate timers. Never leave backup scheduling disabled unnoticed. Do not blindly run success-path restart after a failed/ambiguous maintenance attempt.

## Final SQL checksums

Compare these exact SHA-256 values before authorizing any execution:

```text
448491fcb429da4ecfa8d07f74652e1717a8bf1b84b1a8982bc920704a0162c0  cleanup-test-orders-2026-10-17.sql
43e9537790ee2c875fd3f619ff7797e43f80de1ff369e9a53d35915442240fa4  verify-test-order-cleanup-2026-10-17.sql
```

## Final local verification results

PostgreSQL 16.15: **61 tests passed (60 subtests plus parent), zero failures/skips**. Actual output is in [final evidence](evidence/test-order-cleanup-2026-10-18-final.txt). Default rollback, explicit real commit, all nine failure-injection stages, FK enforcement, preserved rows, exact older-report preservation, cursor/settings preservation, extra/missing dependencies, delivery and report drift, schema changes, concurrent client, changed fingerprints and repeat refusal passed. Actual startup/catch-up methods confirmed no automatic October 17 recreation, including next-day generation of October 18 only.

`npm run check` passed: lint, types, 17 API and 19 frontend unit tests, builds and formatting. Final fixture correction also passed focused ESLint/Prettier and the complete 61-test run. Initial development runs exposed synthetic-fixture deferred-constraint errors; the fixture now validates pending constraints before restoring its guard. Production cleanup SQL was not relaxed. Existing frontend bundle-size warning remains; no UI changes or browser verification are required. Documentation links/diff checks passed. No application logic, migration or production content changed.
