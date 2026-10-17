# Production test-order cleanup review checkpoint

Date: 2026-10-17. Branch: `chore/review-test-order-cleanup`, from updated main `d600d8df810084dec878592246c8a36feafcd108`.

Scope: independently review the owner-provided draft; prepare and test standalone replacement SQL, read-only verification, review findings and an owner-run dry-run/apply runbook. No AWS connection, production reads/writes, migration/application changes or deployment. Stop after delivery; execution needs separate authorization.

The attached draft is truncated at the menu channel count. No claim is made to have reviewed its missing deletion/trigger/transaction ending. Replacement uses exact seven supplied UUIDs and conservative inventory assumptions from the visible draft; six named deletion guards only, active FKs, all-table locking/preservation, schema/ledger checks, default rollback, commit phrase plus reviewed fingerprint. Repeats safely abort. Historical reports and counters are preserved; old browser retries must be discarded.

See [review/runbook](../operations/TEST_ORDER_CLEANUP_2026-10-17.md) and its actual local test output for verification and unresolved operational conditions. The synthetic fixture uses its own PostgreSQL 16.15 Unix-socket cluster with TCP disabled and no inherited environment/database connection. No production backup or data is used. All production execution remains pending.

Verification: PostgreSQL 16.15 disposable suite passed 27 tests (26 subtests plus parent), zero failures/skips. Standalone ESLint/format checks passed. Evidence includes default rollback, explicit commit, scope/schema drift, real FK rejection, injected failure after every deletion, failed trigger restoration, preserved-data mutation and safe repeat refusal.

Full `npm run check` passed: lint, TypeScript, 17 API + 19 frontend unit tests, both builds and formatting. Existing frontend bundle-size warning remains. No UI changes or browser tests were required for this standalone maintenance review.
