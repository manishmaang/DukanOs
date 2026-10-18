# Production test-order cleanup review checkpoint

Date: 2026-10-17. Branch: `chore/review-test-order-cleanup`, from updated main `d600d8df810084dec878592246c8a36feafcd108`.

Scope: independently review the owner-provided draft; prepare and test standalone replacement SQL, read-only verification, review findings and an owner-run dry-run/apply runbook. No AWS connection, production reads/writes, migration/application changes or deployment. Stop after delivery; execution needs separate authorization.

The attached draft is truncated at the menu channel count. No claim is made to have reviewed its missing deletion/trigger/transaction ending. Replacement uses exact seven supplied UUIDs and conservative inventory assumptions from the visible draft; six named deletion guards only, active FKs, all-table locking/preservation, schema/ledger checks, default rollback, commit phrase plus reviewed fingerprint. Repeats safely abort. Historical reports and counters are preserved; old browser retries must be discarded.

See [review/runbook](../operations/TEST_ORDER_CLEANUP_2026-10-17.md) and its actual local test output for verification and unresolved operational conditions. The synthetic fixture uses its own PostgreSQL 16.15 Unix-socket cluster with TCP disabled and no inherited environment/database connection. No production backup or data is used. All production execution remains pending.

Verification: PostgreSQL 16.15 disposable suite passed 27 tests (26 subtests plus parent), zero failures/skips. Standalone ESLint/format checks passed. Evidence includes default rollback, explicit commit, scope/schema drift, real FK rejection, injected failure after every deletion, failed trigger restoration, preserved-data mutation and safe repeat refusal.

Full `npm run check` passed: lint, TypeScript, 17 API + 19 frontend unit tests, both builds and formatting. Existing frontend bundle-size warning remains. No UI changes or browser tests were required for this standalone maintenance review.

## Audit baseline correction — 2026-10-18

Branch `fix/cleanup-menu-audit-baseline` starts from updated main `178d19bfcd4edaac7a3f2463291b3f8312da0eec`. Owner read-only inspection confirms 293 menu audits (133 + 118 + 11 + 31); cleanup dry run was not executed and application was restored. The SQL's only change is 251 → 293. Additional fixture audits use attributed complete Menu before/after aggregates. The production schema digest is unchanged and matches the previously reviewed value; verification SQL is byte-identical.

New tests cover the 293 baseline, 292/294 rejection, unchanged-count audit mutation after fingerprint review, a new October 17 daily report and new October 18 token/Bill counters. All earlier tests remain. New records must stop cleanup for review, never be swept up or removed to satisfy the old inventory. No production connection or maintenance initiated. Updated staging-only instructions and file checksums are in the runbook; the owner separately authorizes the next dry run.

Corrected-baseline verification: **34 PostgreSQL tests passed (33 subtests plus parent), zero failures/skips**. This reruns all 27 original tests plus seven audit/rollover cases; independent before/after preservation checks include all 293 audit rows. Evidence is in `docs/operations/evidence/test-order-cleanup-2026-10-18.txt`.

October 18 project checks: `npm run check` passed (lint, types, 17 API + 19 frontend unit tests, builds and formatting). Documentation links and diff checks passed; only the pre-existing frontend chunk-size warning remains. The correction changes no application logic, migrations or verification SQL, and no production action was taken.
