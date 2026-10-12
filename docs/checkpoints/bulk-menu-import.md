# Rudragiri one-time menu import — review checkpoint

Date: 2026-10-12. Branch: `feature/bulk-menu-import`, created from freshly fetched main `fdef4f7b41d6a26bb88ef29d30e5e9ec640d70f7`.

## Current instruction and scope

The owner superseded the importer-feature request with a standalone transactional, repeat-safe PostgreSQL script, executed personally through psql using protected maintenance credentials. No new application module/API/UI, no migration, no credential changes. First present the entire extracted menu for approval. Do not execute anything further on AWS production. No production import or other production mutation is authorized.

The unfinished MenuService/import-planner application edits from the earlier approach have been removed. Existing application code is unchanged. SQL implementation is pending dataset confirmation, not complete.

## Review artifact

[data/menu-import/rudragiri-menu-review.md](../../data/menu-import/rudragiri-menu-review.md) contains all 15 categories, 120 dish rows and 156 intended HALF/FULL/REFILL variants. Eight explicit ambiguity references cover one missing HALF price, one unresolved dish name and six tentative printed names. A dash is not a zero price. Preserve approved source spelling; do not silently normalize names or invent prices. The approval draft is not executable import data.

## Context and read-only evidence

Read AGENTS, SYSTEM, ARCHITECTURE, DATABASE, DECISIONS, DEPLOYMENT, Menu module, Menu service/repository/policy/draft/DTO, relevant menu migrations 004–007/010 and menu-related platform changes 020/021, migration runner, local maintenance commands and existing Menu integration fixtures. `docs/operations/AWS_CLOUD_HANDOVER.md` is absent.

The owner reports production on EC2 Ubuntu 24.04, PostgreSQL 16 loopback port 5432, database dukanos_prod, schema dukanos, 21 migrations, OWNER created, protected maintenance env `/etc/dukanos/maintenance.env`, application `/opt/dukanos/current`. Do not use local .env for production or reveal credentials.

Before the changed instruction, an authorized read-only SSH Git query verified deployed HEAD `fdef4f7b41d6a26bb88ef29d30e5e9ec640d70f7`, detached HEAD, release `/opt/dukanos/releases/fdef4f7`. A command-local safe.directory option handled root-owned release metadata without writing Git config. No production SQL, service action or file mutation was performed. Older deployment docs describe pre-deployment preparation; they do not override the owner's reported deployed state.

## SQL design to implement after review

Use existing tables only: menu_categories → menu_items → item_variants → variant_channel_settings, plus append-only menu_audit. HALF/FULL/REFILL are supported data-driven names. Counter values are checked exact numeric prices; active category/item/variant/channel and Counter availability are required. New kitchen_name is the approved dish name. Leave platform channels untouched.

Direct SQL bypasses the HTTP session guard and service-created audit, so the controlled maintenance script must explicitly identify/lock an existing active OWNER with menu.manage and append equivalent CREATED audit snapshots (actor, target, before null, after aggregate, timestamps). This is an explicitly run owner maintenance action, not a new public authorization path. Keep the shared advisory transaction lock 742019323 and every existing trigger/constraint. Additive only: exact existing configurations skip with no updates/audits; conflicts abort. Never fill missing children into an existing item because those inserts bump its version through triggers, violating the no-existing-item-change requirement. Never change users, orders, payments, existing photos or historical records.

Use BEGIN/COMMIT, fail-fast psql behavior and rollback on any error. No schema/migration changes. Test with all current migrations only in a disposable PostgreSQL database, including a second run, conflict preservation, late rollback and invalid data. Provide reviewed-file transfer, protected-env credential handling, backup/recovery prerequisites and read-only reconciliation commands. The user runs all final EC2 commands after approval.

## Verification and remaining work

Review-stage checks: 15 categories, 120 dish rows, 156 intended variants; no duplicate category names or case-insensitive dish names within a category; portion patterns match rules; only the explicitly marked price/name are missing. No importer SQL/database tests have run yet because no SQL has been implemented. No frontend changes, so responsive regression is not applicable to this review artifact.

Next: obtain A1–A8 resolutions and full-menu approval; implement/test SQL and runbook, review diff, commit/push branch, then finish mandatory merge only when the milestone is complete. Do not merge this unfinished review stage. Keep this checkpoint current.
