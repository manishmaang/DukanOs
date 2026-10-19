# Production test-order cleanup review checkpoint

> **Completed in production — owner report received 19 October 2026. Do not rerun.** The owner reports successful dry-run rollback, explicit COMMIT, exact nine-group deletion, preservation checks and service restoration. Seven October 10–16 reports and unrelated data were preserved. Actual shop activity has since occurred. See the [production handoff](../operations/EC2_AUTO_START_STOP_HANDOFF_2026-10-19.md) for supplied evidence. The preparation steps and pending conditions below are historical; this documentation update did not connect to production or independently repeat those checks.

## Current revision — October 18 final scope

Branch `fix/final-test-cleanup-oct18`, created from updated main `16b17262fdba91b1dddb1554d442362b04bd80a0`.

The owner reports overnight system cancellation: 7 exact October 17 test orders (2 COMPLETED / 5 CANCELLED), 5 Bills, 4 collections ₹1,100, 9 original items, 18 history rows, 3 Counter CANCEL amendments, 2 Zomato cancellation rows, 1 acknowledged timer and 8 daily reports. Only October 17 v1 is now additionally approved for deletion. Preserve seven October 10–16 reports, 293 menu audits, all other tables and numbering 7/5. This supersedes the earlier cleanup baseline and confirmation phrase.

Preparation is limited to standalone SQL, read-only verification, isolated PostgreSQL tests and documentation. No production access, transfer, service changes or cleanup. Owner separately approves each production stage. No runtime logic/migrations changed.

The SQL captures actual report/amendment identities, requires the real reviewed all-row fingerprint, preserves FKs and restores nine specific deletion guards. Commit additionally needs reviewed report UUID and independent external-send review. Unsafe report cursor, delivery records or changed data abort. Current production cursor and external-send status are not independently verified. Expected initialized cursor: next_date October 18; never edit it to force cleanup. Actual worker tests cover midnight report, 05:00 system cancellations, startup after deletion and next-day catch-up.

See [runbook and final evidence](../operations/TEST_ORDER_CLEANUP_2026-10-17.md) for exact scope, dependencies, checksums, staging-only replacement commands and pending production conditions. Do not execute old staged copies or reuse fixture fingerprints.

## Prior reviews (historical only)

Initial independent review: 27 tests, merged at `178d19b`. Audit correction 251 → 293: 34 tests, work commit `4f7119d`, merged at `16b1726`. Neither certifies the expanded final scope. Their evidence files remain unchanged. The prior production read-only inspection restored the application; no cleanup dry run had been executed.

Final verification: **61 PostgreSQL tests passed**, zero failures/skips; real worker startup/catch-up and all nine deletion-stage rollback checks included. `npm run check` passed (17 API + 19 frontend unit tests, lint/types/build/format); final harness lint/format passed. Final evidence and SHA-256 values are linked in the runbook. Production prerequisites remain unverified; no maintenance initiated.
