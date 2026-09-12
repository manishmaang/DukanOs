# PostgreSQL database

## Implemented schema

Scaffold infrastructure and Auth/Users tables are implemented. Other domain entities below remain a proposed model, **not migrated tables**.

### schema_migrations

Created transactionally by the migration runner. `name text` primary key, `checksum text NOT NULL` (SHA-256), `applied_at timestamptz NOT NULL DEFAULT now()`. Tracks immutable migration files. No foreign keys or secondary indexes.

### app_metadata

Migration `001_foundation.sql`: `key text` primary key with nonempty check, `value text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`. Seeds `application = DukanOS`. No financial semantics, foreign keys, or secondary indexes.

## Migration contract

Run `npm run db:migrate` from the repository root. A transaction-scoped advisory lock serializes runners before ledger creation. All pending SQL and ledger inserts commit atomically. Checksums reject edits to applied migrations; missing applied files and out-of-order additions fail. Use zero-padded ascending filenames. SQL files must not contain transaction control or operations forbidden inside transactions (such as concurrent index creation). No automatic down migrations: restore a backup or ship a reviewed forward correction. Never rewrite applied migrations.

## Proposed domain model

Use UUID primary keys, timestamptz timestamps, explicit FKs and restrictive deletion for historical/financial records. Only introduce tables with their implementing feature and tests.

| Module       | Proposed entities and integrity                                                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu         | categories, menu_items (category FK), item_variants (item FK, unique item/variant code), channel_prices (variant FK, unique variant/channel, numeric(14,2) nonnegative amount), modifiers and item_modifier mappings                                                               |
| Orders       | orders (unique internal number, channel, status, customer FK optional, version, timestamps), order_items and immutable item revisions (order/variant FKs, positive integer quantities, price/name/instruction snapshots), amendment records and status history (actor/reason/time) |
| Payments     | payment_transactions (order FK, tender, positive numeric amount, idempotency key), refunds (original payment FK, positive numeric amount, actor/reason), no destructive updates to posted entries                                                                                  |
| Kitchen      | order-owned queue timestamps and audited priority records; derive aggregation from active item revisions without losing order linkage                                                                                                                                              |
| Customers    | customers (name and indexed normalized mobile; do not assume shared family phone numbers are unique), optional preferences and communication consent                                                                                                                               |
| Credit       | credit_accounts (unique customer FK, eligibility and optional nonnegative limit), ledger_entries (account/order/payment linkage, signed numeric amount, unique operation reference)                                                                                                |
| Integrations | provider_orders (unique provider/external ID, internal order FK), external item/modifier mappings, processing records for deduplication                                                                                                                                            |
| Reports      | initially queries/projections over source records; no independent sales ledger or duplicate financial authority                                                                                                                                                                    |

Monetary values remain numeric(14,2) in PostgreSQL and strings in JSON. Application arithmetic needs an exact decimal implementation before financial features ship. Provisional currency is INR; tax precision/rounding must be decided before totals implementation. Credit entries increase debt for purchases and decrease it for repayments/reversals. Posted transactions are append-only, with linked reversals. Do not count repayments as sales.

## Planned transactional boundaries

- Place order: validate availability/channel prices, persist item snapshots, initial tender or credit debt, status history, and operation key atomically.
- Amend order: lock order, verify expected version/status, append item revisions and amendment reason, compute exact delta, record linked payment/refund/credit adjustment atomically as applicable. External payment calls require a separate durable state machine, not a long-held DB transaction.
- Refund: lock original payment, check remaining refundable balance against all posted refunds, insert refund with unique operation key.
- Credit purchase/settlement: lock credit account before checking balance/limit; insert ledger and tender records together.
- Kitchen transition/priority: lock order or compare version, validate transition, append actor/history, update state once.
- Provider acceptance: unique provider/order ID plus atomic mapping/order persistence makes retries safe.

Establish a consistent lock order when modules interact. Index order queue filters `(status, queued_at, id)`, item order FKs, ledger `(account_id, created_at, id)`, and provider identifiers when those schemas arrive. Use check constraints for valid amounts/statuses and indexes on relevant FK/query paths. Socket events are published only after commit; client retries require persisted idempotency and payload conflict detection.

## Multi-role RBAC requirement (2026-09-12)

DukanOS uses multi-role operational staff because one employee may serve as cashier, kitchen worker, and dispatcher during the same shift. OWNER and MANAGER are exclusive privileged roles and cannot be combined with operational roles or each other. Every user must have exactly one privileged role OR one or more operational roles.

Use users/roles/user_roles and roles/permissions/role_permissions. Never put a single role on users. Effective permissions are the distinct union across assigned roles. Authenticated context exposes roles[] and permissions[]. Capability checks govern APIs and visible POS/Kitchen/Dispatch navigation; screen switching does not require logout. Backend validation and PostgreSQL constraints reject invalid assignments with INVALID_ROLE_COMBINATION. Implemented by migration `002_auth_rbac.sql`.

## Implemented Auth/Users schema — 002_auth_rbac.sql

| Table            | Columns and integrity                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| users            | UUID PK; unique normalized username with format check; nonblank name; password_hash; active boolean; positive integer version; created_at timestamptz. No role column.                                                                                     |
| roles            | code text PK; category text constrained to the five fixed role/category pairs. OWNER/MANAGER PRIVILEGED; CASHIER/KITCHEN/DISPATCH OPERATIONAL.                                                                                                             |
| user_roles       | Composite PK (user_id, role_code); restrictive FKs to users and roles; reverse index (role_code,user_id). BEFORE membership INSERT/DELETE updates parent version and obtains a row lock; UPDATE of a membership is rejected (replace using delete/insert). |
| permissions      | code text PK; explicit capability catalog.                                                                                                                                                                                                                 |
| role_permissions | Composite PK (role_code,permission_code); restrictive FKs; permission_code index. Effective permissions use DISTINCT over every assigned role.                                                                                                             |
| auth_sessions    | SHA-256 token_hash text PK with hex/length check; user_id FK; created_at/expires_at timestamptz with positive lifetime check; indexes on user and expiry. Raw tokens never stored.                                                                         |
| login_attempts   | Hashed key PK; positive attempts counter; window_start timestamptz with cleanup index. Atomic upserts implement account/IP limits.                                                                                                                         |
| user_audit       | UUID PK; optional system actor_id FK, target_id FK, checked action, nonblank reason, old/new JSONB, timestamp; target/time index. UPDATE/DELETE rejected by trigger.                                                                                       |

All FKs use restrictive deletion; historical user references must not be removed. Deferred triggers on users INSERT and user_roles INSERT/DELETE validate a nonempty final role set and privileged exclusivity at transaction commit, raising SQLSTATE 23514 / INVALID_ROLE_COMBINATION. Parent-row updates serialize membership writers and force serialization conflicts under stronger snapshot isolation, preventing write skew. Role catalog category checks prevent reclassifying fixed roles. Schema/table owners can alter or disable database enforcement; application code must not do so.

Role replacement, account status/version, session revocation and user audit insertion share one transaction. Staff mutations take advisory lock 742019322 before checking actor authority or last active owner. Login locks/rechecks user version after hashing before inserting a session. Migration runner uses a distinct advisory lock 742019321. Permission union/session lookup is one SQL snapshot; requests already authorized before a revocation may finish, so future sensitive mutations must recheck permission within their transactional boundary as Users does.

The initial role grant matrix is recorded in [Users](modules/users.md). No financial tables or money calculations are introduced by this migration.

## Password management — 003_password_management.sql

No new tables. The migration adds users.password.reset and grants it to OWNER and MANAGER. The existing user_audit action constraint is extended with PASSWORD_CHANGED, PASSWORD_RESET, OWNER_RECOVERED; existing migrations are unchanged.

`password_audit_safe_payload` requires credential events to have null old_value and exactly `{passwordChanged:true,sessionsRevoked:true}` as new_value. `password_audit_actor` requires self-change actor=target, administrative reset actor≠target with a nonnull actor, and local recovery actor=null. Existing audit immutability and reason/timestamp/FK rules remain intact.

Password mutations use staff advisory lock 742019322 and ordered row locks. They recheck the live session, current permissions/roles and version as appropriate, update users.password_hash and version, delete auth_sessions for the target, clear account-specific login_attempts counters, and insert audit in one transaction. New hashes are computed before acquiring locks. Login's existing version recheck rejects passwords verified against an earlier credential version. No financial/menu schema changes are included.
