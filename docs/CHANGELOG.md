# Changelog

## 2026-09-25 — Audible operational alerts

### Added

- Optional local Web Audio payment reminder and Kitchen timer patterns, explicit activation, device-local mute preference and Test sound.
- Coalesced non-overlapping playback with 60-second payment / 20-second Kitchen repeat limits, workspace/capability scope and resolution suppression.
- Audio coordinator tests and Chromium activation/playback/offline regression coverage; physical-device smoke checklist.

### Changed

- Mounted alert projections continue polling in running background tabs for authoritative reconciliation; visual alerts remain mandatory and suspended-browser alarms are not guaranteed.
- No schema, backend, financial, reminder scheduling or Kitchen lifecycle changes.

## 2026-09-24 — Bills, service types and collections

- Added parent Bills with Dine In/Takeaway, references, independent daily numbering, multiple Kitchen rounds and explicit settled/all-rounds-completed closure.
- Added append-only Cash/UPI partial collection, authoritative financial projections, actor/time history, transaction/constraint guards and recoverable idempotent requests.
- Added responsive POS Open Bills, Add Items and settlement; Dispatch displays limited due/service and gates Takeaway only. Kitchen retains preparation semantics and loses generic financial read access.
- Migration 012 preserves existing snapshots/history and maps old orders to marked unknown-service legacy bills without fabricated payments. Documented cash-only future refunds; refunds/amendments remain disabled.
- Verified the complete check suite, all 89 PostgreSQL integration tests, existing browser regressions and new four-device-class Bill scenarios. Applied migration 012 locally with checksum preservation checks and no fabricated payments; updated earlier fixtures for bill context.

## 2026-09-23 — Responsive and touch audit

- Made responsive/touch design and mobile, tablet portrait/landscape and desktop workflow verification permanent requirements in AGENTS.md and docs/RESPONSIVE_UI.md.
- Added compact workspace selection, a single live phone/portrait POS cart dialog with persistent View Order, landscape menu/cart columns and keyboard-aware viewport handling.
- Adapted Menu to focused narrow-screen editing and labelled stacked portion/channel pricing; enlarged staff, disclosure and category actions and hardened long-text/image/dialog layout.
- Verified all eight required viewport sizes and four touch workflow classes, all 77 PostgreSQL integration tests, existing Menu/Kitchen/Dispatch browser regressions and the complete check suite. Physical mobile browser/keyboard verification remains a hardware follow-up.
- Preserved existing Kitchen/Production/Dispatch grids and all backend/domain behavior. Added eight-size touch/browser audit with isolated local fixtures and screenshot review; no migrations or business-data changes.

## 2026-09-23 — Dispatch handover

### Added

- READY-only Dispatch workspace with oldest-ready ordering, token/portion quantities, secondary notes and Handed Over actions; responsive cards, configurable READY-age attention, new-arrival highlighting and local polling/recovery.
- Dedicated dispatch.read queue and dispatch.complete command using existing role grants and multi-role navigation.
- Migration 011 extends Orders' history-driven guards to READY→COMPLETED and indexes READY history; existing records and immutable sale data are preserved, without redundant timestamp columns.
- PostgreSQL and Chromium coverage for lifecycle handoff, migration preservation, permissions, concurrent/stale completion, rollback, reconnect and responsive UI. No payment dependency, undo or provider integration.

### Verified

- `npm run check` passed; all 77 PostgreSQL tests and Dispatch, Kitchen and Menu/POS Chromium regressions passed. Desktop/tablet Dispatch screenshots reviewed; browser traffic restricted to local services.
- Migration 011 applied locally and rerun safely. Digests confirmed all 20 existing data tables and the existing image unchanged; three existing READY orders remain available for handover.

## 2026-09-23 — MVP checkpoint

- Marked and pushed fixed annotated tag `v0.1.0-mvp` at `df2d141`, preserving the completed authentication, Menu, Counter Orders and Kitchen stage.
- Documented the checkpoint, recovery branch command and separate database/upload/configuration backup requirements in README and SYSTEM. The tag remains on the original implementation commit, before this documentation update.
- Corrected stale README statements about Kitchen implementation and local order/Kitchen operation.

## 2026-09-22 — Production card titles

- Combined snapshotted portion and item names into one uppercase Production title beside the total; long names wrap independently of the quantity.
- Kept instruction breakdowns, responsive grid, source associations and Order View unchanged. Added browser title/wrapping regression checks.

## 2026-09-22 — Compact Kitchen and operational availability

### Changed

- Compact responsive Order/Production grids and small empty sections; Production hides token metadata and combines matching instruction quantities without changing original source associations.
- Same-day Order cards omit redundant dates; cross-date work remains explicit.

### Added

- Configurable total-age late highlighting, default >=15 minutes, with static red treatment and no FIFO changes.
- Kitchen Counter Availability search/panel with whole-dish and portion sold-out/restore through existing Menu APIs/audit.
- Migration 010 grants KITCHEN only the existing menu.availability.manage capability; Zomato/Swiggy and menu administration stay independent.
- Boundary, permission, audit and browser coverage for density, instruction splits, late/reduced-motion treatment and Kitchen/POS availability synchronization.

### Verified

- `npm run check` passed (10 API unit tests and 10 frontend/helper tests); all 68 PostgreSQL integration tests passed. Kitchen and existing Menu/POS Chromium regressions passed.
- Migration 010 applied locally: only the requested role permission was added; all other 19 data tables and the image file were unchanged.

## 2026-09-22 — Kitchen Display System

### Added

- Large-text Kitchen Order/Production views, FIFO NEXT/START, audited READY, live local timers and new-token highlighting.
- Operational-only read APIs and server-derived queued/preparing production totals with every source line and instruction retained.
- Migration 009: history-driven lifecycle transitions, unique destinations and FIFO enforcement; existing records and financial snapshots preserved.
- Two-second local state polling, action/conflict/reconnect recovery, stale-action suppression and multi-role workspace switching.
- PostgreSQL concurrency/migration/permission tests and an isolated multi-device Chromium scenario (`test:kitchen-browser`).

### Verified

- `npm run check` passed (9 API unit tests, 8 frontend/helper tests); all 68 PostgreSQL tests passed.
- Existing Menu/POS Chromium regression and Kitchen multi-device/browser scenarios passed with external requests blocked.
- Applied migration 009 locally; before/after digests confirmed all 20 existing data tables and the existing image file unchanged.

## 2026-09-21 — Menu/POS and API hardening

### Added

- Counter-only whole-dish/portion sold-out controls and an explicit operational capability for OWNER/MANAGER/CASHIER (migration 007).
- Counter read model retaining sold-out cards, immediate local feedback and five-second multi-device polling.
- Repository-wide API validation audit and strict transport/query contracts, DTO bounds and safe parser errors.
- Media-cleanup dry-run, removal/deferred counts and immediate compensation for failed upload/file staging.

### Fixed

- Staff create/access HTTP mutations now recheck session validity after transactional waiting.
- Null active flags, unbounded portion arrays/versions, malformed channel inputs and ignored body/query fields are rejected.

### Verified

- `npm run check` and all 46 PostgreSQL tests pass, including cross-family malformed payloads, concurrent availability, upload/file failures and queued session revocation.
- Two independent Chromium sessions verify sold-out/restoration propagation, unchanged other-channel prices, image replacement/removal and existing navigation with external requests blocked.
- Local migration 007 preserved every menu row, all 25 audit entries and the existing uploaded image byte-for-byte. Cleanup dry-run reported zero candidates; no real media was removed.
- Compression fixture: 545,574-byte JPEG became 100,072-byte normalized WebP (about 82% smaller); actual photo savings vary.

## 2026-09-21 — Local menu photos and visual POS

### Added

- Migration 006: optional item photo references and local image metadata, preserving existing menu/history.
- Permission-protected JPEG/PNG/WebP upload, orientation/resize/metadata stripping, local WebP serving, replacement/removal and explicit orphan cleanup.
- Dish photo preview and Counter visibility guidance; visual Counter-only POS with category buttons, search, photo fallback and read-only portion dialog.
- PostgreSQL image lifecycle/authorization/validation tests, visibility diagnostics and populated migration preservation coverage.

### Fixed

- POS now refreshes on focus, menu changes and every 15 seconds while visible. Replacement photos have fresh URLs.
- Explained the actual missing Soya Chaap record: saved inactive after creation despite valid Counter prices. Activation rules and existing data remain intact.

### Verified

- `npm run check` and all 42 PostgreSQL integration tests pass. Chromium verifies upload/replace/remove, Counter-only portions, category/search filters, automatic refresh, fallback and cashier access with external requests blocked.
- Migration 006 applied locally with before/after comparison: 2 categories, 2 dishes, 4 portions, 12 channel settings and 21 audit records preserved. Existing Soya Chaap activation was not changed. Browser scenarios use disposable fixtures and generated test images.

## 2026-09-12

### Added

- Persistent system, architecture, database, decision, and ten-module documentation.
- NestJS/React npm workspace scaffold with shared API types and placeholder workspaces.
- API liveness/readiness, environment validation, DTO validation setup, and sanitized errors.
- PostgreSQL Compose setup, transactional checksum-verified migrations, and initial metadata table.
- Type checking, linting, formatting, API smoke tests, and setup instructions.

### Clarified

- Single-location scope and local execution baseline for internet-outage continuity; final hosting remains undecided.
- Domain functionality and WAN-disconnected ordering verification remain future phases.

### Verified

- Linting, workspace type checks, two HTTP/configuration tests, production builds, and formatting checks pass.
- Initial migration applied to PostgreSQL 16; a repeat run performed no changes. Ledger checksum and metadata seed were inspected.
- Compiled frontend and database readiness respond through the running API.
- Fresh dependency resolution with the Multer override reports zero npm audit vulnerabilities.

### Added — Staff authentication and multi-role RBAC

- Migration 002 adds staff, categorized roles, many-to-many grants, sessions, login limits, and immutable staff audit records.
- Domain validation and concurrency-safe deferred database constraints enforce operational combinations and privileged exclusivity.
- Local password sign-in, expiring/revocable session cookies, default authentication guard, capability checks, and CSRF header enforcement.
- Owner bootstrap CLI and protected staff creation/access APIs with version checks, last-owner protection, and session revocation.
- Sign-in and staff administration UI, plus permission-filtered POS/Kitchen/Dispatch navigation without logout when switching screens.
- Exhaustive role-policy tests, workspace permission tests, and isolated PostgreSQL/HTTP integration tests for authorization and concurrent assignments.

### Verified — RBAC

- Four API/domain tests, one workspace-capability test, and nine PostgreSQL-backed integration scenarios pass.
- All 32 role subsets were checked in both domain logic and PostgreSQL; nine valid combinations were accepted.
- Concurrent access edits/direct SQL assignments, session revocation, deactivation, expiry, logout, login limits, and capability denials were verified.
- Lint, type checks, production builds, and formatting pass. Migration 002 was applied locally; the running server reports readiness and rejects anonymous staff access.

### Changed — GitHub delivery

- Recorded standing authorization in AGENTS.md to commit and push every completed major or minor achievement to manishmaang/DukanOs.
- GitHub delivery includes reviewing staged files, preserving remote history, and verifying the pushed commit.

### Added — Password management

- Authenticated current-password changes with confirmation UI, shared strength validation, verification rate limits, and revocation of all sessions.
- OWNER/MANAGER staff password resets with a separate capability, restricted target lists, administrative reasons, version checks and transactional permission/session rechecks.
- Local owner-recovery CLI with hidden input/stdin, exact owner selection, loopback-only database connection and repeat-safe audited recovery.
- Migration 003 adds reset grants and credential-safe audit action/payload/actor constraints.
- Password-policy tests and real PostgreSQL/HTTP/CLI integration coverage for successful, forbidden and concurrent operations.
- Menu development remains pending; no operational restaurant modules were added.

### Verified — Password management

- Full check suite passed: lint, type checks, six API/domain tests, one workspace test, production builds, and formatting.
- Both PostgreSQL integration suites passed (23 scenarios), including local owner recovery and concurrent password changes/resets.
- Manually verified hidden terminal password entry and safe confirmation-mismatch failure without changing an account.
- Applied migration 003 to local development PostgreSQL.

### Changed — Module branching workflow

- Require a separate branch from updated main for every new module or independently scoped milestone.
- Push intermediate achievements to the work branch and merge completed, verified modules back into main with a merge commit.
- Persisted the workflow and standing merge authorization in AGENTS.md and SYSTEM.md.

## 2026-09-12 — Menu foundation

### Added

- Migration 004: categories, items, flexible variants, configured channels, exact INR prices, separate availability and immutable menu audit.
- Capability-protected menu administration and operational read APIs, aggregate version conflicts and PostgreSQL integrity tests.
- Admin category/item/variant editing with channel pricing table; read-only POS menu preview.
- menu.read for OWNER/MANAGER/CASHIER/KITCHEN; modifier design documented as deferred.

## 2026-09-19 — Menu management UX

### Changed

- Dedicated Menu workspace with grouped search, one dish editor, inline portions, side-by-side prices and a single Save action.
- Added transactional nested item creation/full-dish PUT, preserving stored identities, availability, version checks and audit.
- Migration 005 removes manual sort_order metadata while preserving all existing menu records and audit history. Admin is newest first; POS uses stable oldest-first creation order.
- Inline category editing, channel-wide availability switches, editable Standard initial portion, immediate validation and tablet-friendly controls.

### Tested

- Nested-save rollback, authorization, obsolete-field rejection, deterministic ordering and a populated-database upgrade; desktop/tablet Chromium workflow with non-local requests blocked.

## 2026-09-22

### Added

- Counter Orders Core, migration 008: atomic confirmation, daily restaurant-timezone tokens, actor-scoped idempotency, immutable sale/tax snapshots and initial status history.
- Exact paise totals with configurable exclusive tax defaulting to zero; no rupee rounding or payment transactions.
- POS cart with portions, quantities, kitchen notes, safe confirmation retry and token success state; retained menu photos/availability controls.
- Confirm/detail/date-token/FIFO list APIs, KITCHEN read capability, transactional and browser regression coverage.

### Changed

- Refined POS dish selection into a 1040px maximum, two-column dialog with compact image, persistent action footer and adaptive tablet layout.
- Added simultaneous portion quantities, exact live totals and atomic batch cart insertion with shared or optional per-portion notes; retained existing merge and order semantics.
- Prioritized stored portion names over conflicting display labels; investigated actual SCG-H/F values without altering menu data. Availability actions remain compact secondary controls.

- Widened POS to a 1480px maximum workspace with a compact dish-grouped cart, independently scrolling items and persistent totals/confirmation.
- Replaced shared/default-visible instructions with independent optional portion/line editors; cart notes can be added, edited or removed without reopening a dish.
- Added stable frontend line identities, item-based presentation grouping and price-aware merge checks while preserving the confirmation API and database semantics.

## 2026-09-25

### Added

- Server-priced POS payment review with atomic Cash/UPI full, partial/split and Pay Later confirmation; payment-bound idempotency and changed-payable rejection.
- Persistent Dine In reminder intervals/snooze, automatic settlement pause/new-round resume, capability-filtered multi-device tray and known-state offline fallback.
- Persistent Kitchen timers with presets/custom duration, optional order/item association, due/overdue alerts and concurrent safe acknowledgement/cancellation.
- Migration 013, operational-alert contracts/documentation and transactional/browser regression coverage.

### Changed

- Bill rounds now show immutable food/portion/quantity/instruction snapshots, with tokens secondary.
- Existing POS browser regressions explicitly select Pay Later after the new review step. Kitchen lifecycle/aggregation, Dispatch handover rules and all historical sale/payment records remain unchanged.

### Fixed

- Opening a Bill URL while POS is already mounted now selects that Bill; viewing a confirmed Bill clears its completed cart context before a new sale.
- Reminder tray placement avoids payment-field overlap; Kitchen timer strips no longer inherit the general page minimum height.
- Browser harnesses tolerate Chromium's cancelled interception IDs during reload without hiding other failures.

### Verified

- Complete check suite, all 95 PostgreSQL tests and Menu/POS, Kitchen, Dispatch, Bills, responsive and new operational-alert browser suites passed. Four touch workflow sizes, eight layout sizes, offline fallback/reconciliation and combined-payment retry were exercised with external requests blocked.
- Local migration 013 preserved all 23 existing tables after accounting for intentional grants/new nullable provenance; the restarted application passed readiness/protected-endpoint checks. Physical device/background alarm behavior remains outside Chromium emulation coverage.
