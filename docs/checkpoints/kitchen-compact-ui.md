# Kitchen compact UI — 2026-10-21

Branch: fix/kitchen-compact-order-cards, created from freshly fetched main 76bad69. This is a presentation-only follow-up to the completed [real-shop workflow](real-shop-workflows.md). No production connection, deployment, AWS change or migration is authorized/performed.

## Discovery and scope

Read AGENTS.md (only root applies), SYSTEM, README as the repository documentation entry point, real-shop checkpoint/deployment review, Kitchen/Orders/POS/Dispatch/Auth/Responsive/Database context, migration 022 and Kitchen read/fulfillment contracts. Serving and POS are documented in Kitchen and Orders rather than separate invented module files. Inspected Kitchen.tsx, ServingLabel, styles.css, shared Kitchen projections, service/controller/DTOs and existing browser/integration fixtures.

Root causes: kds-order-grid used CSS Grid default stretch, unlike Production's explicit align-items:start. Short cards therefore matched the longest card in the row. The handover button's auto top margin pushed it to the bottom of that unnecessary height. Global form margins added 24px above and below every serving form, while growing quantity labels and full-width inputs consumed space even for single portions. Cards had no necessary business-driven minimum height.

Changed only frontend presentation, regression scripts and docs. Natural top-aligned row-major cards preserve chronological/FIFO/NEXT guidance and existing three/two/one-column breakpoints. No masonry, fixed card heights or nested card scrolling. Compact headers retain token, source, service/reference and waiting or LATE age without repeating age. A scoped div wrapper avoids inheriting application header styles.

Each stable line keeps its identity, portion, ordered/pending/served counts and explicit serving action. Larger quantities default to all pending with a bounded 4rem numeric input; one pending portion gets Serve 1 without an input. Quantity edits do not submit. Correction quantity/reason and permission guards are preserved; fully served lines remain muted/readable with correction access until completion. Instructions remain exact plain text under their source line, with pre-wrap/highlight and no truncation. Production retains aggregate totals/grouping/instruction summary and additionally shows each source line's exact instruction and platform reference from the same Kitchen response.

Backend, API/shared contracts, financial rules, permission grants, serving transactions/idempotency, timers/audio implementation, polling, aggregation and migration 022 are unchanged. No new migration. No architecture decision required: this removes default CSS stretching and scopes UI spacing within the existing components.

## Measurements and screenshots

Same isolated fixture before/after: one-item Dine-In, ten independent lines with Half/Full and long multiline instructions, short settled Parcel and Zomato LESS QUANTITY. Values are CSS pixels from bounding rectangles.

| Viewport | Short before → after | Ten lines before → after | Parcel before → after |
| -------- | -------------------- | ------------------------ | --------------------- |
| 390×844  | 395.9 → 213.9        | 2556.6 → 1415.0          | 332.8 → 279.1         |
| 768×1024 | 2556.6 → 213.9       | 2556.6 → 1402.6          | 332.8 → 279.1         |
| 1024×768 | 2483.5 → 213.9       | 2483.5 → 1332.2          | 332.8 → 279.1         |
| 1440×900 | 2483.5 → 213.9       | 2483.5 → 1332.2          | 2483.5 → 279.1        |

Local evidence: /tmp/dukanos-kitchen-compact-before.json and -after.json; screenshots /tmp/dukanos-kitchen-compact-before-WIDTHxHEIGHT.png, -after-WIDTHxHEIGHT.png, -production-WIDTHxHEIGHT.png and -served-late.png. Screenshots represent disposable fixtures, not restaurant data. Baseline generated before frontend changes with KITCHEN_LAYOUT_BASELINE=1; default test mode asserts natural heights and functional workflows. Normal screenshots wait for the timer polling surface to settle. Desktop and phone before/after, tablet portrait Order, tablet landscape Production and served/LATE screenshots visually reviewed. Instructions and actions are readable and unclipped.

## Verification

All commands use disposable PostgreSQL 16 at 127.0.0.1:55439 (not .env/production), CHROME_BINARY=/opt/google/chrome/chrome. Browser tests block external traffic, create/drop unique schemas and remove their fixture profiles.

- npm run check: PASS (lint, typechecks, 18 API + 19 frontend unit tests, production build, formatting). Existing Vite bundle-size advisory remains. Log /tmp/dukanos-compact-final-check.log.
- DATABASE_URL=<local fixture URL> node --test apps/api/test/integration/kitchen*.test.cjs apps/api/test/integration/dispatch.test.cjs apps/api/test/integration/amendments.test.cjs apps/api/test/integration/bills.test.cjs: **58 passed, 0 failed, 0 skipped**. Covers serving/concurrency/audits, lifecycle, payment gating, amendment exclusion and permissions. Log /tmp/dukanos-compact-integration.log.
- `node scripts/test-kitchen-layout-browser.cjs`: PASS at nine sizes (360×800, 390×844, 430×932, 768×1024, 1024×768, 1280×800, 1440×900, 1600×900, 390×420). Measures natural heights/FIFO order, checks no page overflow and 44px minimum targets (serving controls 48px), exact multiline instructions, portion identities, source-specific instructions/platform references, touch partial serving/correction/completion, stale second-device rejection, Parcel/platform handover, served state, waiting/LATE/NEXT and pending production totals. Log /tmp/dukanos-compact-layout-final.log.
- `node scripts/test-real-shop-browser.cjs`, `node scripts/test-platform-browser.cjs`, `node scripts/test-responsive-browser.cjs`, `node scripts/test-bills-browser.cjs` and `node scripts/test-alerts-browser.cjs`: PASS. Final logs: /tmp/dukanos-compact-real-shop-delivery.log, -platform-delivery.log, -responsive-final.log, -responsive.log (Bills), and -alerts-final.log. A grouped command was terminated after both PASS messages; standalone reruns of real-shop and platform both passed with clean exit code 0. Alerts verified real Web Audio activation/patterns, timer/reminder persistence and offline reconciliation at four workflow classes and eight boundaries. Updated old exact Serve selectors to also recognize Serve 1. Fixed the platform harness to wait for the legacy /dispatch redirect to finish before reading the resulting Kitchen card; no routing behavior changed.

Final lint, format check and git diff --check passed after documentation/test updates. No skipped tests in the executed suites; the full unrelated integration collection was not rerun for this frontend-only refinement.

Physical Android/iOS/Safari keyboard, screen reader and hardware smoke tests remain unverified. Desktop Chromium emulation is not a physical-device claim. Row gaps below shorter cards are intentional to preserve FIFO; no masonry optimization is planned.

## Documentation and deployment

Updated Kitchen, RESPONSIVE_UI, SYSTEM/master context, CHANGELOG and README checkpoint status; this file records discovery/evidence. Frontend implementation is limited to Kitchen.tsx and styles.css. Test script command added to package.json: test:kitchen-layout-browser. No deployment performed. A matching build and normal authorized release/client refresh are required. This change adds no database/runtime-grant requirement; if the real-shop milestone is not yet deployed, its separate migration 022 deployment prerequisites still apply. For this UI-only change, retain the prior matching release assets for normal release rollback; never reverse 022 or restore/delete operational data to undo UI styling. Staff should smoke-test partial serve/correction, Parcel settlement gate, platform LESS, Production instructions and phone/tablet layouts after an authorized release.

## Delivery

Verified work is delivered on fix/kitchen-compact-order-cards and merged with --no-ff into updated main under repository policy. Exact commit hashes are recorded in Git and the completion response. No production action accompanies Git delivery.
