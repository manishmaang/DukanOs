# Changelog

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
