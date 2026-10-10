# Shared platform POS and qualitative preparation checkpoint

Started: 2026-10-10; verification completed: 2026-10-11. Work branch: `fix/simplify-platform-pos-ux`, created from updated main `f48a812` (Manual Platform Orders V1). Scope: reuse Counter dish selection, remove mandatory measured platform preparation, preserve history and all operational/financial boundaries. No AWS resource creation or deployment, no live restaurant database migration.

## Context loaded before implementation

Main files: AGENTS.md, README.md, docs/SYSTEM.md, docs/ARCHITECTURE.md, docs/DATABASE.md, docs/DECISIONS.md, docs/CHANGELOG.md, docs/DEPLOYMENT.md, docs/PRODUCTION_READINESS_AUDIT.md, docs/RESPONSIVE_UI.md and docs/API_VALIDATION.md.

Module files: docs/modules/auth.md, users.md, menu.md, orders.md, platform-orders.md, kitchen.md, dispatch.md, bills.md, payments.md, amendments.md, reports.md, daily-reports.md and alerts.md. POS, Production, refunds and cleanup are documented within these modules; no separate duplicate documents were created.

Previous checkpoints: docs/checkpoints/aws-pilot-preparation.md, manual-platform-orders.md and manual-platform-verification.md. Reviewed current Counter/platform selection, carts and confirmation, Menu aggregate configuration, snapshots/migrations, Kitchen/Production/Dispatch, cancellation/cleanup, authorization, Bills/Payments, financial report cohorts and existing test harnesses.

## Implemented design

- DishSelection.tsx is the single selector for Counter/Zomato/Swiggy: same photos, compact portions, steppers, independent notes and persistent footer. Its discriminated props keep priced Counter lines separate from price-free platform selections. Counter checkout, Bills and Payments are unchanged.
- PlatformPos.tsx asks for reference and Normal/Less only at review. NORMAL is the default; REDUCED displays LESS QUANTITY. No automatic discount inference, measurements, prices, financial total or payment endpoint. Requests use the existing HTTP-LAN-compatible UUID helper. Pending requests survive reload in per-user/source tab storage; uncertain/auth/idempotency failures retain that identity.
- Migration 021 adds orders.preparation_mode without rewriting any row. New platform inserts require NORMAL/REDUCED and null discount classification. New item serving columns remain null; operational reads derive mode from the immutable order. Existing Counter/source-conditioned financial invariants, uniqueness, sealing and lifecycle guards remain.
- Migration-020 records retain null order mode, exact per-line measured snapshots (including mixed modes), original discounts and request hashes. Legacy request bodies can only replay a matching committed order; uncommitted old drafts return PLATFORM_REVIEW_REQUIRED. No conversion guesses a uniform historical mode.
- Menu removes measured-size controls. It omits old measurement properties when saving; backend aggregate semantics preserve omitted values. Retained optional legacy API fields still validate if supplied, but new ordering never requires or consults them.
- Kitchen, platform tracking and Dispatch render qualitative mode or legacy mode plus actual measured amount. Production's existing source/item/variant/name/mode/amount/unit key remains intact, preserving associations and separation. No Production token UI, FIFO/actions/timers/availability change.
- Platform handover remains settlement-free. Counter Takeaway still requires collection and refund due both zero. Platform cancellation/05:00 cleanup remain audited and financial-effect-free. Reports/Daily Reports continue to follow Bills.

## Changed file groups

- database/migrations/021_platform_preparation_mode.sql (only new migration).
- packages/shared-types/src/platform-orders.ts.
- apps/api/src/modules/orders/platform-orders.dto.ts and platform-orders.service.ts; kitchen/kitchen.service.ts; dispatch/dispatch.service.ts.
- apps/web/src/DishSelection.tsx, PlatformPos.tsx, ServingLabel.tsx, Menu.tsx, menu-editor.ts and styles.css.
- apps/api/test/kitchen.test.cjs; integration/platform-orders.test.cjs, bills.test.cjs and order-cleanup.test.cjs; apps/web/test/menu-editor.test.cjs; scripts/test-platform-browser.cjs.
- AGENTS.md, README.md, System/Architecture/Database/Decisions/Changelog/Responsive/API Validation, Menu/Orders/Platform Orders/Kitchen/Dispatch/Reports/Daily Reports and this checkpoint.

## Verification status

- `npm run check` passed: lint, typechecks, 17 API unit tests, 19 frontend unit tests, API/web production builds and formatting.
- Full PostgreSQL integration suite: 234 tests passed, zero failures/skips. This includes 22 platform suite tests (including its parent), migration-020 row/snapshot preservation, legacy request replay, new mode/default validation, database financial/mode constraints, idempotency/concurrency, availability, lifecycle/cleanup and financial report isolation.
- All 11 browser suites passed: Menu, Responsive, Kitchen, Dispatch, Bills, Alerts, Amendments, Reports, Expenses, Daily Reports and Platform. Menu, Platform and Responsive were rerun successfully after the short-height CSS fix. Responsive exercised all eight standard sizes plus constrained-height forms.
- Platform browser coverage includes four complete workflows at 390×844 (mobile), 768×1024 (tablet portrait), 1024×768 (tablet landscape) and 1440×900 (desktop), both Swiggy modes, a committed response loss followed by reload/double retry, and boundaries 360×800, 430×932, 1280×800, 1600×900 and 390×420. Browser fixtures block external traffic.
- Screenshots visually reviewed: shared Counter/platform mobile selector, all four platform device classes, mobile review, tablet Production, desktop Dispatch and the corrected short-height selector. Touch controls, notes, independent portions and reachable Add Items were exercised; Counter regressions passed.
- `npm audit --omit=dev`: zero vulnerabilities. Production builds succeeded; the existing frontend chunk-size warning remains.
- Test schemas/databases were disposable. No restaurant migration or operational data changes occurred.

Initial full integration run found two outdated migration fixtures: a preservation comparison needed to exclude only the new nullable field, and a cleanup fixture stopped at 020 before reading with current code. Both fixtures are corrected; no production rule was weakened. Sandbox-only unit execution could not bind local sockets; full checks run with approved local socket access. Expanded browser coverage found the inherited short-height selector rule could clip Add Items after note editing; removing its whole-dialog scrolling override keeps the shared header/footer visible and scrolls the body, verified at 390×420.

## Upgrade and remaining limits

The restaurant schema/data were not migrated, deleted or reset. Migration 021 must be applied with the matching release only in a separately authorized, backed-up upgrade. Existing migrations 001–020 remain untouched. Retained Menu measurements are compatibility data, not required configuration. New orders support one mode only; mixed-mode new entry is deferred. Cancelled platform references remain permanently reserved. Unsent carts remain memory-only; sessionStorage recovery does not survive tab deletion. Physical Android/iOS keyboards, speakers and assistive technology remain restaurant smoke checks. The existing large frontend bundle warning remains outside this refinement.

No deployment, AWS resource, provider API, billing/settlement, cloud sync or unrelated feature was added. Future work must start on a new branch from updated main after an explicit user request. This file is the current persistent checkpoint; put the next milestone's checkpoint under docs/checkpoints/ and update AGENTS.md then.
