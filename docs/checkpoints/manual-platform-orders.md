# Manual platform orders V1 checkpoint

Authorized milestone: manual operational-only Zomato/Swiggy entry, menu serving profiles, shared Kitchen/FIFO/Production/Dispatch, cancellation and cleanup. No provider API, financial participation, live migration or AWS deployment.

Branch: `feature/manual-aggregator-orders-v1`, created from fetched/fast-forward main `4875884`. Migration `020_manual_platform_orders.sql` is new; 001–019 are unchanged. Existing restaurant schema/data have not been migrated. Main was fetched again before delivery and remains at that base.

## Implemented

- Source-conditioned order/line financial constraints; immutable operational serving snapshots; permanent platform-reference uniqueness and idempotent requests.
- Menu single-save Normal/Reduced g/ml configuration independent of optional platform prices; price-free POS platform entry, explicit serving review, tracking and audited cancellation.
- Shared Kitchen FIFO/lifecycle, source/profile-separated Production, platform Dispatch without payment; Counter settlement guards unchanged.
- Append-only platform cancellation records and existing configured 05:00 cleanup/timer integration with no Bill or financial revision.
- Dedicated create/read/cancel capabilities for OWNER/MANAGER/CASHIER; existing Kitchen/Dispatch capabilities remain narrow.

## Verification

`npm run check` passed (16 API + 18 frontend unit tests, lint/typecheck/format and production builds). Full PostgreSQL integration passed **232/232, zero failures/skips**, including 19 platform subtests plus their parent. Production audit: **zero vulnerabilities**. Existing Vite >500 kB chunk warning remains.

All **11 browser suites passed**: Menu, Responsive, Kitchen, Dispatch, Bills, Alerts, Amendments, Reports, Expenses, Daily Reports and Platform. The final Responsive run includes the shared cart height correction. Platform suite exercises actual Menu profile saves, default Normal/explicit Reduced, source lock, submission, Kitchen/Production/Dispatch, tracking and cancellation at all four device classes. Extra boundary/short-height checks and screenshot review completed. See [verification and requested-case mapping](manual-platform-verification.md).

## Delivery and next session

Implementation and verification are complete. Deliver through the feature branch and the authorized `--no-ff` main merge; Git history is the authoritative record of commit/merge hashes. No further feature work remains in this milestone. Do not start another milestone automatically. No live migration or deployment is authorized. Restaurant upgrade still requires an explicit backed-up maintenance/migration step and real serving configuration. Cancelled references cannot be corrected/reused in V1; measured Counter profiles and provider APIs/reconciliation remain deferred. Physical mobile keyboards/hardware remain smoke-test limitations.
