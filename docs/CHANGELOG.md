# Changelog

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
