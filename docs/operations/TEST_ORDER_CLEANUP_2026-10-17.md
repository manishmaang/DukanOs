# October 17 test-order cleanup — independent safety review

## Decision and evidence boundary

**The supplied draft is not approved:** the attachment ends mid-condition at `variant_channel_settings) <> 468`. Its deletion statements, trigger handling and transaction ending were not supplied and cannot be reviewed. The complete [replacement SQL](../../scripts/cleanup-test-orders-2026-10-17.sql) is independently implemented for the owner's exact seven-order inventory, with a default full ROLLBACK rehearsal. It is not permission to execute. No production connection, transfer, cleanup, service action or backup operation occurred during this review.

The owner reports an encrypted October 17 backup created and its S3 object verified. That is not a new decryption/restore test or independent freshness verification. Confirm its recoverability and that no relevant data was added after it before proceeding. Every record below must genuinely be test data; SQL cannot establish that business fact. Deleting ₹1,100 of recorded payments does not return or reconcile actual cash/UPI money.

All 21 immutable migrations, active trigger definitions, order/payment/report relationships, report generation locks, and backup maintenance behavior were reviewed. No application logic, migration, normal retention policy or financial correction workflow is changed.

## Corrected baseline — 18 October 2026

The owner's read-only production inspection found **293 menu audit records**, not the initial 251 assumption: October 12 CREATED 133; October 13 UPDATED 118; October 14 UPDATED 11; October 15 UPDATED 31. All 293 records, including the additional 42, must remain unchanged. The owner stopped and restored the application for inspection; **the cleanup dry run was not executed**. This correction changes only the SQL count gate from 251 to 293. Seven exact order UUIDs, schema/migration checks, trigger/FK protections, full preserved-row comparisons, confirmation and default rollback are unchanged.

The owner-reported schema digest matches the existing expected digest `6b9ec2c9e9afb656f13677f85606a61ef6a7d0b691edd2d21c2b0c44eca16f72`; it is not changed. The read-only verification SQL is unchanged: it already reports actual per-table counts/digests. No production data fingerprint has been supplied, invented or embedded; a later separately authorized successful dry run must produce it.

**Midnight/restart check:** these are dated inventory expectations, not a license to clear whatever now exists. An October 17 daily report makes eight reports and stops cleanup. A new date's token/Bill counter, extra order/payment/timer, cancellation or amendment also stops it. A data change after fingerprint review rejects apply even when counts stay unchanged. If any gate fails, preserve the new records and obtain a new review; do not delete historical reports, reset counters, broaden IDs or relax the baseline. Since the application has been restored, recheck the inventory during the next separately authorized maintenance window. Calendar midnight alone is not a DELETE filter.

### Replace the already-staged file only

These commands transfer files; they do **not** run SQL, stop services or begin maintenance. Run the laptop steps from the updated repository. The existing verification file needs no replacement if its checksum below matches.

```bash
# Owner's laptop
sha256sum scripts/cleanup-test-orders-2026-10-17.sql scripts/verify-test-order-cleanup-2026-10-17.sql
scp -i ~/Downloads/DukanOs_EC2.pem scripts/cleanup-test-orders-2026-10-17.sql ubuntu@13.233.74.152:~/cleanup-test-orders-2026-10-17.sql.reviewed-293
```

On EC2, verify the uploaded file, stage with the existing ownership, then atomically replace the old SQL. Stop on any failed checksum; do not run the later steps in this runbook until separately authorized.

```bash
cd ~
printf '%s  %s\n' 'bd7c2843ae7920080a62ff3b182ffe8d5da892df83369d1b6e61d68b04060608' 'cleanup-test-orders-2026-10-17.sql.reviewed-293' | sha256sum --check &&
sudo install -o root -g postgres -m 0640 cleanup-test-orders-2026-10-17.sql.reviewed-293 /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup-test-orders-2026-10-17.sql.new &&
sudo mv /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup-test-orders-2026-10-17.sql.new /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup-test-orders-2026-10-17.sql
sudo sha256sum /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup-test-orders-2026-10-17.sql /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/verify-test-order-cleanup-2026-10-17.sql
```

Expected file SHA-256 values (not database fingerprints):

```text
bd7c2843ae7920080a62ff3b182ffe8d5da892df83369d1b6e61d68b04060608  cleanup-test-orders-2026-10-17.sql
3bbb3c37755c89c60d34ead55846cf140c0a6023dbae2fe7b8d21f6ddf598d75  verify-test-order-cleanup-2026-10-17.sql
```

No `git pull` on the application release, application rebuild, migration, runtime grant or service restart is required merely to replace this staged maintenance file. Preserve the earlier read-only inspection logs; capture a fresh baseline for the later authorized run.

## Supplied SQL review and corrections

| Supplied statement/block                                   | Finding and replacement                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ON_ERROR_STOP`, default `apply=false`, BEGIN              | Retained. Use `psql -X -f`, not an interactive paste; errors must terminate the connection and roll back. No intermediate commits.                                                                                                                                 |
| Search path and timeouts                                   | Retained; UTC/ISO serialization added for stable row fingerprints. Production target remains fixed `dukanos_prod` / `dukanos`; no configurable production-target override. PostgreSQL major 16 and local administrative identity `postgres` required.              |
| Restaurant advisory lock 742019323                         | Necessary but insufficient alone. Added migration lock 742019321, report-generation lock 742019324, and deterministic ACCESS EXCLUSIVE locks on all 39 application tables before validation. All other database clients must be disconnected.                      |
| `apply`/confirmation strings                               | Accept only exact `true` or `false`; commit requires the exact phrase AND SHA256 of all rows from a reviewed successful dry run. Prevents silent change between rehearsal and apply.                                                                               |
| Seven explicit UUIDs and order counts/statuses/date/source | Retained exact scope. Added token identity 1–7, timer order token #2, Asia/Kolkata and event-date checks. The draft's two COMPLETED/five QUEUED and Dine In assumptions are additional conservative gates: if actual inventory differs, stop for re-review.        |
| Bill/child/payment inventory                               | Retained, including four COLLECTIONs ₹1,100, one ₹280 Cash plus three UPI totaling ₹820. Bills are derived only from target orders, exactly five distinct parents; deletes use captured IDs, never a date sweep. Payment confirmation references must be in scope. |
| Timer and empty dependency checks                          | Retained exact timer UUID, target order, ACKNOWLEDGED/order-only association. No reminder, amendment, revision or platform-cancellation deletion is allowed. Unexpected records abort.                                                                             |
| Historical reports, delivery rows, expenses and counters   | Retained expected counts. Seven distinct October 10–16 dates required; report JSON must not embed target order/bill UUIDs. Counters stay 7/5. All preserved rows compared exactly before/after, including settings, staff and audits.                              |
| Menu condition ending `<> 468`                             | Incomplete SQL. Replacement completes it and checks 293 audits. Full before/after comparisons protect menu values/versions/images, not just counts.                                                                                                                |
| Missing remainder                                          | No inference that it was safe. Replacement uses only six named non-internal trigger disables; scoped child-first deletes and exact row-count assertions; explicit re-enable, immediate constraints, schema/trigger and preserved-row checks before commit.         |

Exact 001–021 names/checksums are embedded. A portable PostgreSQL-16 schema SHA256 covers tables, columns/defaults, constraints, functions, non-internal triggers, indexes and rewrite/view definitions. It must match the disposable migrated schema. Enabled event triggers, external-schema incoming FKs, altered/missing/disabled triggers, unrecognized schema objects or ledger drift abort. Internal FK trigger names contain instance-specific OIDs, so their enabled state is checked separately; FK definitions/validation are in the schema digest. No `DISABLE TRIGGER ALL`, `session_replication_role` override, TRUNCATE, CASCADE, temporary objects or permanent helper objects are used.

No snapshot payload or password hash is printed. The whole-database review digest includes staff/session/settings rows in memory; if any of those change after rehearsal, apply must abort and the owner must re-review. A schema fingerprint mismatch is a stop condition, not a reason to replace the expected hash with whatever production returns.

## Exact deletion scope

| Order UUID                           | Allowed population                  |
| ------------------------------------ | ----------------------------------- |
| f6cca944-a322-4f3a-a021-a21b2bc7c7fc | One of the seven listed orders      |
| 87776115-adf3-4ec9-a62e-829374a47ede | Token #2; acknowledged timer parent |
| 1dd1fb53-a551-47a7-8109-85fe889d4441 | One of the seven listed orders      |
| 4d2bb443-edc1-46de-9da1-b2d21e730456 | One of the seven listed orders      |
| 3d499b63-c885-425f-ac2a-21cb2c06df46 | One of the seven listed orders      |
| f29f9147-4929-48f7-ae4a-009891fc7ea9 | One of the seven listed orders      |
| f70effcb-5a1e-4cfe-9bb1-ae5b1a52715d | One of the seven listed orders      |

All seven belong to October 17: five COUNTER, two ZOMATO; two COMPLETED and five QUEUED. The script does not guess which other UUID maps to which source/token. Read-only output lists the actual mapping for owner review.

| Table                                                                                | Delete | Preserve / postcondition                                                                                                                              |
| ------------------------------------------------------------------------------------ | -----: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| kitchen_timers                                                                       |      1 | Exactly `273e996f-81c6-45bd-8bd8-95f836bc3722`; none remain                                                                                           |
| payments                                                                             |      4 | Exactly linked collections ₹1,100; none remain                                                                                                        |
| order_status_history                                                                 |     13 | Only target-order history; none remain                                                                                                                |
| order_items                                                                          |      9 | Only target-order lines; none remain                                                                                                                  |
| orders                                                                               |      7 | Exact UUID set; none remain                                                                                                                           |
| bills                                                                                |      5 | Captured Counter parents, DINE_IN; none remain                                                                                                        |
| order_daily_tokens / bill_daily_numbers                                              |      0 | October 17 last_token=7, last_number=5                                                                                                                |
| daily_reports                                                                        |      0 | Seven October 10–16 snapshots, byte-equivalent JSONB and all metadata                                                                                 |
| menu_categories / menu_items / item_variants                                         |      0 | 15 / 118 / 156, all fields unchanged                                                                                                                  |
| variant_channel_settings / menu_audit                                                |      0 | 468 / 293, all fields unchanged                                                                                                                       |
| amendments, revisions, platform cancellations, reminders, expenses, delivery records |      0 | Remain empty as inventoried                                                                                                                           |
| All remaining application tables                                                     |      0 | Staff/roles/sessions/audits, menu images, expense categories/receipts/audits, settings/report audits, metadata and migration ledger exactly unchanged |

## Dependencies and indirect effects

- Payments reference Bills and optionally confirmation Orders; delete payments before orders/bills. Payment reminder synchronization runs on INSERT only, not DELETE.
- Timers reference Orders and optionally the composite `(order_id,order_item_id)` in order_items. Delete the exact timer first; no unrelated/unassociated timer is tolerated.
- Order history and original items reference Orders; Orders reference Bills, staff and channel configuration. Original items reference Menu. Parent deletion cannot cascade to Menu or staff; no FK cascade is introduced or disabled.
- Amendment headers reference Orders/Bills; revision lines reference headers and original items; platform cancellations reference Orders. These must be empty. Their three guards remain enabled.
- Reminders reference Bills. There are none. Bill reminder synchronization is UPDATE-only; deleting Bills does not run it.
- `effective_orders`, `effective_order_items` and `bill_balances` are ordinary views, not stored snapshots: they become empty. Kitchen/Dispatch queues and live financial aggregates lose the test rows. No view needs rebuilding.
- Daily report JSON captures historical aggregates/menu/expense identities, not an order FK. Deliveries reference reports, attempts/actions reference deliveries. Reports are preserved; future reports and live Reports reflect the cleaned source data. No automatic regeneration or resend is performed.
- Menu child-version/audit triggers are not invoked. User role/session/audit, expense/media and migration records are not written. No upload files are read or removed.
- The nine relevant deletion guards are `immutable_kitchen_timer`, `protect_payments`, `immutable_order_history`, `immutable_order_items`, `immutable_orders`, `protect_bills`, `protect_amendments`, `protect_revision_items`, `protect_platform_cancellation`. Only the first six are disabled, inside the same transaction. Explicit restore before final checks; error/disconnection ROLLBACK also restores their original enabled state. All FK triggers stay active throughout.
- Deletion removes order/payment idempotency identities and platform external-reference uniqueness records. **Close all existing POS tabs and discard pending test-request retries before restarting.** An old client retry could otherwise create a new order/collection after cleanup. No user/session revocation is performed because those records must be preserved.

## Numbering, repeats and limits

October 17's next confirmed order is token **#8**, next new Bill **#6**. A new calendar date follows normal independent allocation from #1; counters are never reset or tokens recycled. Historical report snapshots remain authoritative records of their generation, even if future live analytics differ.

Repeated execution **safely refuses** with `CLEANUP_ORDER_BASELINE_CHANGED`, even after a successful commit; it is not a reset command or automatic no-op. If COMMIT outcome is uncertain, run the read-only verification and inspect logs before retrying. A mixed/partial state is never repaired automatically. New orders, rollover/cancellation, report generation, date changes or migrations may invalidate this narrowly dated inventory. Do not widen predicates, change IDs, alter counts or disable more triggers to make it pass.

A privileged administrator can deliberately modify a reviewed file; SQL cannot protect against that. Compare transfer checksums and keep the script root-controlled. The tests use synthetic records, not production row contents, media, credentials or backups. This review does not establish whether any actual payment needs external reconciliation, or prove a full production restore.

## Local verification

Run on the development laptop only:

```bash
node scripts/test-test-order-cleanup.cjs
npx eslint scripts/test-test-order-cleanup.cjs
npx prettier --check scripts/test-test-order-cleanup.cjs
```

The harness creates a fresh `initdb` PostgreSQL 16 cluster under a random mode-0700 `/tmp/dukanos-cleanup-review-*` directory. It connects only through that directory's private Unix socket; TCP is disabled. Its internal database is named `dukanos_prod` to test the unmodified production-name gate. This is a new disposable cluster, not the production database. It ignores `.env`, DATABASE_URL, PGHOST and inherited credentials; uses explicit clean child environments, creates synthetic records using all 21 migrations/active constraints, and shuts down/removes only its generated cluster. Never run this harness on EC2 or point it at an existing socket. Requires local `/usr/lib/postgresql/16/bin` and repository Node dependencies; no application build is required.

**Original review: 27 tests passed (26 subtests plus parent), zero failures/skips**, PostgreSQL 16.15. ESLint and formatting passed. Historical results: see [original test output](evidence/test-order-cleanup-2026-10-17.txt). Corrected-baseline results are recorded separately in [October 18 evidence](evidence/test-order-cleanup-2026-10-18.txt). Tests cover dry-run preservation, explicit confirmation, changed fingerprints, UUID mismatch, extra bills/orders/payments, other clients, ledger/schema/FK changes, external dependencies, disabled guards, FK enforcement while application guards are disabled, failure after each of six deletions, unintended preserved-row mutation, report references, commit, safe repeat refusal and read-only verification. Every negative execution compares all table contents and schema/trigger state against its immediate pre-execution state.

## Owner-only execution runbook — requires separate authorization

These are reviewable future procedures, **not executed by the agent**. The cleanup intentionally requires `postgres` administrative identity because it temporarily changes named financial guards. Use local OS peer authentication via `sudo -u postgres`; no application credentials, command-line database passwords or runtime-role escalation. The regular maintenance identity remains unchanged.

### 1. Transfer reviewed files from laptop

```bash
sha256sum scripts/cleanup-test-orders-2026-10-17.sql scripts/verify-test-order-cleanup-2026-10-17.sql
scp -i ~/Downloads/DukanOs_EC2.pem scripts/cleanup-test-orders-2026-10-17.sql scripts/verify-test-order-cleanup-2026-10-17.sql ubuntu@13.233.74.152:~/
```

On EC2, stage root-controlled copies; compare hashes with the laptop output:

```bash
sudo install -d -o root -g postgres -m 0750 /var/lib/dukanos-maintenance/2026-10-17-test-cleanup
sudo install -o root -g postgres -m 0640 ~/cleanup-test-orders-2026-10-17.sql ~/verify-test-order-cleanup-2026-10-17.sql /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/
sudo sha256sum /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/*.sql
```

Do not execute the truncated attachment. No git pull, migration, application rebuild or release switch is needed.

### 2. Establish approved downtime and capture before-state

First confirm the October 17 encrypted backup/S3 object and recovery keys are usable, the exact inventory is still test-only, no money reconciliation is outstanding, and the owner has authorized this window. Close all operational browser tabs, discard pending test requests, stop other maintenance jobs and disconnect DB tools. Record current release with `git -C /opt/dukanos/current rev-parse HEAD`. Keep the app stopped from before-state capture through post-commit verification.

Use **one root shell** for the remainder, holding the backup wrapper's same OS lock. Stop timers to prevent a backup job from unexpectedly restarting the app; restore only timers that were active. Do not interrupt an active backup. Record these prior states in the maintenance log as well, in case the shell disconnects.

```bash
sudo -i
umask 077
exec 9>/run/lock/dukanos-backup.lock
flock -n 9 || { echo 'Another backup/maintenance window is active; stop here.'; exit 1; }
if systemctl is-active --quiet dukanos-backup.service; then echo 'Backup active; stop here.'; exit 1; fi
cleanup_backup_timer_state=$(systemctl is-active dukanos-backup.timer || true)
cleanup_monitor_timer_state=$(systemctl is-active dukanos-monitor.timer || true)
install -d -m 0700 /var/log/dukanos-maintenance
printf 'backup=%s monitor=%s\n' "$cleanup_backup_timer_state" "$cleanup_monitor_timer_state" > /var/log/dukanos-maintenance/cleanup-timer-states.txt
systemctl stop dukanos-backup.timer
if systemctl is-active --quiet dukanos-backup.service; then echo 'Backup service still active; stop and investigate before proceeding.'; exit 1; fi
if [ "$cleanup_monitor_timer_state" = active ]; then systemctl stop dukanos-monitor.timer; fi
systemctl stop dukanos.service
systemctl is-active dukanos.service
# Expected: inactive. Stop if active/activating or other supervisors can restart it.
set -o pipefail
sudo -u postgres env -i PATH=/usr/bin:/bin psql -X -h /var/run/postgresql -U postgres -d dukanos_prod -f /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/verify-test-order-cleanup-2026-10-17.sql 2>&1 | tee /var/log/dukanos-maintenance/cleanup-before.txt
```

The root shell must remain open to retain lock FD 9. Inspect the read-only mapping/counts and preserved-table hashes. No restore/reset operations belong in this step.

### 3. Full rollback dry run

```bash
sudo -u postgres env -i PATH=/usr/bin:/bin psql -X -h /var/run/postgresql -U postgres -d dukanos_prod -f /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup-test-orders-2026-10-17.sql 2>&1 | tee /var/log/dukanos-maintenance/cleanup-dry-run.txt
```

Require exit status zero, `CLEANUP_DELETED` matching the six counts, `CLEANUP_PRESERVATION_AND_TRIGGER_CHECKS_PASSED`, and **`CLEANUP_DRY_RUN_ROLLED_BACK`**. Copy the `CLEANUP_REVIEW_FINGERPRINT` value from this successful run; never use a test fixture's hash. Re-run read-only verification and compare before-state: everything must still be unchanged. Any failure means stop, inspect, and re-review; no automatic application of a partially successful rehearsal.

### 4. Explicit commit — separate owner decision

Only after reviewing the dry-run evidence and separately authorizing destruction:

```bash
read -r -p 'Paste the reviewed dry-run CLEANUP_REVIEW_FINGERPRINT: ' cleanup_fingerprint
sudo -u postgres env -i PATH=/usr/bin:/bin psql -X -h /var/run/postgresql -U postgres -d dukanos_prod \
  -v apply=true \
  -v confirm=DELETE_20261017_7_ORDERS_5_BILLS_4_PAYMENTS \
  -v expected_fingerprint="$cleanup_fingerprint" \
  -f /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/cleanup-test-orders-2026-10-17.sql 2>&1 | tee /var/log/dukanos-maintenance/cleanup-apply.txt
```

Require zero exit status and **`CLEANUP_COMMITTED`**. A different digest, error, timeout or disconnected client is not success. If the connection is lost around COMMIT, verify the actual state before deciding what to do. The script never creates a permanent cleanup marker or alters audit tables; retain this operator log, reviewed file hash and encrypted backup as maintenance evidence.

### 5. Read-only post-check, then resume

```bash
sudo -u postgres env -i PATH=/usr/bin:/bin psql -X -h /var/run/postgresql -U postgres -d dukanos_prod -f /var/lib/dukanos-maintenance/2026-10-17-test-cleanup/verify-test-order-cleanup-2026-10-17.sql 2>&1 | tee /var/log/dukanos-maintenance/cleanup-after.txt
```

Require all six target tables empty; counters 7/5; all nine named guards `O`; zero disabled triggers/unvalidated FKs; same schema digest; every other table's count/hash identical to `cleanup-before.txt`. Reopen devices only after clearing pending test retries. Then, in the same root shell:

```bash
systemctl start dukanos.service
curl --fail --silent --show-error https://rudragiri-velvase.duckdns.org/api/health/ready
if [ "$cleanup_backup_timer_state" = active ]; then systemctl start dukanos-backup.timer; fi
if [ "$cleanup_monitor_timer_state" = active ]; then systemctl start dukanos-monitor.timer; fi
flock -u 9
exit
```

Worker startup may subsequently roll over dates or generate new reports; compare preservation evidence **before** restarting. If maintenance fails, keep the app stopped until rollback/trigger/data state is verified. For a failed/disconnected root shell, recover timer states from the saved log and restore them deliberately; do not leave backups unintentionally disabled. Restore from backup is a separate approved procedure, not an automatic fallback that might overwrite newly accepted orders.

Full `npm run check` passed: lint, TypeScript, 17 API + 19 frontend unit tests, both builds and formatting. Existing frontend bundle-size warning remains. No UI changes or browser tests were required for this standalone maintenance review.

Corrected-baseline verification: **34 PostgreSQL tests passed (33 subtests plus parent), zero failures/skips**. This reruns all 27 original tests plus seven audit/rollover cases; independent before/after preservation checks include all 293 audit rows. Evidence is in `docs/operations/evidence/test-order-cleanup-2026-10-18.txt`.

October 18 project checks: `npm run check` passed (lint, types, 17 API + 19 frontend unit tests, builds and formatting). Documentation links and diff checks passed; only the pre-existing frontend chunk-size warning remains. The correction changes no application logic, migrations or verification SQL, and no production action was taken.
