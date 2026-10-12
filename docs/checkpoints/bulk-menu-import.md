# Rudragiri one-time menu SQL import checkpoint

Date: 2026-10-12. Branch: `feature/bulk-menu-import`, created from freshly fetched main `fdef4f7b41d6a26bb88ef29d30e5e9ec640d70f7`.

## Current instruction and scope

The owner superseded the importer-feature request with a standalone transactional, repeat-safe PostgreSQL script, executed personally through psql using protected maintenance credentials. No new application module/API/UI, no migration, no credential changes. The complete menu was presented; the owner resolved A1–A8 on 2026-10-12. Do not execute anything further on AWS production. No production import or other production mutation is authorized.

The unfinished MenuService/import-planner application edits from the earlier approach have been removed. Existing application code is unchanged. The standalone SQL, read-only verification file and operator runbook are implemented; no application code changes remain.

## Corrected data and artifacts

[data/menu-import/rudragiri-menu-review.md](../../data/menu-import/rudragiri-menu-review.md) contains 15 categories, 118 dishes and 156 variants. All ambiguities were resolved by the owner: Butter Paneer Masala REGULAR/HALF/FULL ₹120/170/210; Chole ₹90/110/160; Sev Tamatar FULL ₹130; Badi Fry FULL ₹120; Kothe FULL ₹110; Chinese Thali FULL ₹210; Macroni HALF/FULL ₹90/110. Separate Regular entries were merged into their parent dishes. Preserve these corrections over initial image readings.

`scripts/seed-rudragiri-menu.sql` is self-contained psql input, not a migration. `scripts/verify-rudragiri-menu.sql` supplies read-only checks. [Operator runbook](../operations/MENU_IMPORT.md) covers review/transfer, protected-env psql invocation, backup prerequisite, dry-run/apply, reconciliation and recovery. `scripts/test-rudragiri-menu-import.cjs` is local-only disposable database coverage.

## Context and read-only evidence

Read AGENTS, SYSTEM, ARCHITECTURE, DATABASE, DECISIONS, DEPLOYMENT, Menu module, Menu service/repository/policy/draft/DTO, relevant menu migrations 004–007/010 and menu-related platform changes 020/021, migration runner, local maintenance commands and existing Menu integration fixtures. `docs/operations/AWS_CLOUD_HANDOVER.md` is absent.

The owner reports production on EC2 Ubuntu 24.04, PostgreSQL 16 loopback port 5432, database dukanos_prod, schema dukanos, 21 migrations, OWNER created, protected maintenance env `/etc/dukanos/maintenance.env`, application `/opt/dukanos/current`. Do not use local .env for production or reveal credentials.

Before the changed instruction, an authorized read-only SSH Git query verified deployed HEAD `fdef4f7b41d6a26bb88ef29d30e5e9ec640d70f7`, detached HEAD, release `/opt/dukanos/releases/fdef4f7`. A command-local safe.directory option handled root-owned release metadata without writing Git config. No production SQL, service action or file mutation was performed. Older deployment docs describe pre-deployment preparation; they do not override the owner's reported deployed state.

## Implemented SQL design

Use existing tables only: menu_categories → menu_items → item_variants → variant_channel_settings, plus append-only menu_audit. REGULAR/HALF/FULL/REFILL are supported data-driven names. Counter values are checked exact numeric prices; active category/item/variant/channel and Counter availability are required. New kitchen_name is the approved dish name. Leave platform channels untouched.

Direct SQL bypasses the HTTP session guard and service-created audit, so the controlled maintenance script explicitly identifies/locks an existing active OWNER with menu.manage and appends equivalent CREATED audit snapshots (actor, target, before null, after aggregate, timestamps). This is an explicitly run owner maintenance action, not a new public authorization path. Uses the shared advisory transaction lock 742019323 plus table locks and every existing trigger/constraint. Additive only: exact existing configurations skip with no updates/audits; conflicts abort. Never fill missing children into an existing item because those inserts bump its version through triggers, violating the no-existing-item-change requirement. Never change users, orders, payments, existing photos or historical records.

BEGIN/COMMIT and fail-fast psql roll back on any error. Default execution rehearses all inserts, audits and deferred constraints then ROLLBACK; explicit apply/confirmation persists. Guarded target/schema ownership, exact 001–021 checksums and OWNER capability are checked. No schema/migration changes. New creation times preserve board/portion order. Complete audit snapshots match the application repository, including Counter visibility. The user runs all final EC2 commands personally; no additional host connection was made after the instruction change.

## Verification and remaining work

SQL integration and existing Menu tests run only against disposable local PostgreSQL data; no migration was run against restaurant data. The SQL test seeds a real paid Counter order and snapshots all tables to prove existing users, financial history, unrelated menu and audits remain intact. It covers simultaneous first imports, repeated exact no-op, default rollback, negative/overprecision prices, unsupported portions, missing categories, duplicate dishes, empty data, owner/confirmation checks, injected late audit failure, audit equality, read-only reconciliation, partial existing records and preserved custom kitchen/platform settings. A separate test compares every SQL portion/price with the Markdown review table.

`npm run check` passed (lint, typechecks, 17 API + 19 frontend unit tests, API/web builds and formatting). Standalone SQL suite: 18 tests passed, including its parent test. Existing Menu/migration integration suites: 20 tests passed. No failures/skips. The existing frontend bundle-size warning remains. No frontend changes; responsive regression is not applicable. No application feature or migration was added. Exact-schema compatibility is deliberately conservative; later migrations require review, not bypassing checks. Production dry-run, backup confirmation, import and live UI/readiness checks remain the owner's actions. Menu corrections later use the audited UI; this SQL never updates existing dishes.

Keep this checkpoint and the runbook current. Do not start another milestone or execute on production automatically.
