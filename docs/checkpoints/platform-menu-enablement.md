# Platform menu enablement checkpoint

Date: 2026-10-13. Branch: `chore/enable-platform-menu`, created from updated main `6959566c5c9152e32cafb252297d2018874f6650`.

## Scope and production boundary

The owner reports the restaurant menu import completed in production: 15 categories, 118 dishes, 156 Counter variants and 133 CREATED menu audit records; no platform settings yet. This task prepares separate one-time SQL to copy current Counter prices to SWIGGY/ZOMATO and enable availability. The owner executes final EC2 commands personally. No production connection, SQL, file transfer, privilege change, service action or deployment was performed during development.

The original `seed-rudragiri-menu.sql` is unchanged and was not rerun, even for this task's tests. No migration, application/API/UI code or production build is introduced. Preparation remains order-wide Normal/Less; measured settings stay NULL. No provider integration/publication occurs.

## Context read and files

Read AGENTS, SYSTEM, DATABASE, DEPLOYMENT, Menu and Platform Orders docs, Menu service/repository/validation, migrations 004/020/021 and the existing menu import SQL/runbook. Existing application lock/version/audit conventions remain authoritative.

- `scripts/enable-platform-menu.sql`: psql transaction with default rollback; explicit apply/confirmation; no temporary objects.
- `scripts/verify-platform-menu.sql`: independent read-only counts, per-variant comparisons and audit attribution.
- `scripts/test-enable-platform-menu.cjs`: disposable local PostgreSQL coverage using existing MenuService fixtures, a non-superuser schema-owning role with TEMP revoked, and a real paid Counter order.
- `docs/operations/PLATFORM_MENU.md`: exact reviewed-file transfer, protected maintenance-env psql invocation, dry-run/apply/verification and recovery guidance.
- Relevant system/database/menu/changelog/runbook pointers and this checkpoint updated.

## Integrity

Requires expected database/schema ownership, unchanged 001–021 checksums, active OWNER with menu.manage, enabled triggers, three active channels and the stated complete sellable Counter baseline. Existing matching platform rows are skipped, including timestamps/version side effects. Any conflicting price, null price, unavailable flag or measured configuration aborts before writes. Partial matching configuration adds only missing rows.

Shared advisory lock 742019323 plus menu table locks serialize writers. Snapshot SQL matches the complete application Menu aggregate (photos, labels, descriptions, timestamps, channel ordering and visibility). Each affected item gets one UPDATED audit; existing triggers increment item versions per inserted setting. Counter settings, identities, metadata, previous audits, users and financial records are untouched. Variables/custom transaction-local settings avoid needing TEMPORARY; no permanent objects or functions are created.

Initial state yields 312 inserts, 118 new audits and 251 total audits. Repeats yield zero inserts/audits. A count change, inactive/sold-out Counter baseline or missing Counter price deliberately stops for review. This is a one-time copy, not ongoing price synchronization.

## Verification and pending owner work

The 13 new SQL tests passed (including the parent test): rollback, permissions/confirmation, injected late failure, simultaneous first applies, complete before/after snapshot equality, repeat no-op, read-only verification, four conflict types, partial configuration, missing Counter price/inactive channel, exact paise values and full preservation checks. Actual false has_database_privilege(...,'TEMP') was asserted for the non-superuser test role before execution.

`npm run check` passed: lint, types, 17 API + 19 frontend unit tests, build and formatting. Existing Menu/migration PostgreSQL suites passed 20 tests. The sandbox-only check initially could not bind test sockets; the approved local-socket rerun passed. Existing frontend chunk-size warning remains. No frontend changes; responsive browser work is not applicable. Production transfer, recovery-point confirmation, dry-run, apply, readiness and UI verification remain owner actions. Do not execute them automatically or grant TEMP. Subsequent work requires a new branch from updated main.
