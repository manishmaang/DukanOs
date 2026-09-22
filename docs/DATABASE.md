# PostgreSQL database

## Implemented schema

Scaffold infrastructure, Auth/Users, Menu and Orders tables are implemented. Other domain entities below remain proposed, **not migrated tables**.

### schema_migrations

Created transactionally by the migration runner. `name text` primary key, `checksum text NOT NULL` (SHA-256), `applied_at timestamptz NOT NULL DEFAULT now()`. Tracks immutable migration files. No foreign keys or secondary indexes.

### app_metadata

Migration `001_foundation.sql`: `key text` primary key with nonempty check, `value text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`. Seeds `application = DukanOS`. No financial semantics, foreign keys, or secondary indexes.

## Migration contract

Run `npm run db:migrate` from the repository root. A transaction-scoped advisory lock serializes runners before ledger creation. All pending SQL and ledger inserts commit atomically. Checksums reject edits to applied migrations; missing applied files and out-of-order additions fail. Use zero-padded ascending filenames. SQL files must not contain transaction control or operations forbidden inside transactions (such as concurrent index creation). No automatic down migrations: restore a backup or ship a reviewed forward correction. Never rewrite applied migrations.

## Proposed domain model

Use UUID primary keys, timestamptz timestamps, explicit FKs and restrictive deletion for historical/financial records. Only introduce tables with their implementing feature and tests.

| Module            | Proposed entities and integrity                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders extensions | Future immutable amendments/revisions; base Orders schema is implemented below.                                                                                                                   |
| Payments          | payment_transactions (order FK, tender, positive numeric amount, idempotency key), refunds (original payment FK, positive numeric amount, actor/reason), no destructive updates to posted entries |
| Kitchen           | order-owned queue timestamps and audited priority records; derive aggregation from active item revisions without losing order linkage                                                             |
| Customers         | customers (name and indexed normalized mobile; do not assume shared family phone numbers are unique), optional preferences and communication consent                                              |
| Credit            | credit_accounts (unique customer FK, eligibility and optional nonnegative limit), ledger_entries (account/order/payment linkage, signed numeric amount, unique operation reference)               |
| Integrations      | provider_orders (unique provider/external ID, internal order FK), external item/modifier mappings, processing records for deduplication                                                           |
| Reports           | initially queries/projections over source records; no independent sales ledger or duplicate financial authority                                                                                   |

Future financial values are proposed as numeric(14,2) in PostgreSQL and strings in JSON. Menu uses checked numeric instead, to reject excessive scale without silent rounding. Orders arithmetic uses BigInt paise; currency is INR and exclusive configurable tax is rounded HALF_UP once to paise. Credit entries increase debt for purchases and decrease it for repayments/reversals. Posted transactions are append-only, with linked reversals. Do not count repayments as sales.

## Planned transactional boundaries

- Confirm Counter order (implemented): validate availability/prices, persist sale/tax snapshots, daily token, status history and request identity atomically. No tender or credit debt is created.
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

## Menu — 004_menu_foundation.sql and 005_menu_automatic_ordering.sql

| Table                    | Columns and integrity                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| menu_categories          | UUID PK, trimmed name (1–100), description, active, positive version, created_at/updated_at; unique lower(name).                                                                              |
| menu_items               | UUID PK, restrictive category FK, trimmed name (1–120), description, optional kitchen_name, active, version, timestamps; unique category/lower(name), category/creation index. No item price. |
| item_variants            | UUID PK, restrictive menu_item_id FK, trimmed name (1–80), optional display_label, active, timestamps; unique item/lower(name), item/creation index. Parent is immutable.                     |
| sales_channels           | Stable code PK with uppercase format check, name, active, timestamps. Initial COUNTER/ZOMATO/SWIGGY rows; additional channels use explicit migrations.                                        |
| variant_channel_settings | Composite PK (variant_id, channel_code), restrictive FKs, exact price, independent available flag default false, timestamps; available-channel index. Keys immutable.                         |
| menu_audit               | UUID PK, actor user FK, exactly one category/item FK, CREATED/UPDATED action, before/after JSON snapshots, created_at; target/time indexes. UPDATE/DELETE rejected.                           |

Prices are INR decimal strings in JSON. PostgreSQL `numeric` with `price >= 0 AND price < 1000000000000 AND scale(price) <= 2` provides up to 12 integral digits and 2 fractional digits (₹999999999999.99 maximum). Unconstrained numeric with checks deliberately avoids numeric(14,2) silently rounding an overprecision input. API accepts plain decimal strings and normalizes two fractional digits without floating-point conversion. Orders performs exact totals/tax arithmetic separately.

Deferred constraints require each item to retain at least one variant at commit. Categories/items have version/timestamp triggers; variant and price/availability writes update the parent item's version and acquire its row lock. API menu writes use advisory lock 742019323, recheck the actor session/capability inside the transaction and compare expected category/item aggregate versions. A concurrent stale edit returns MENU_VERSION_CONFLICT rather than overwriting. Operational catalog reads use a repeatable-read snapshot. The broad write lock is appropriate for this single small restaurant; no distributed locks are used.

Availability is computed from active category/item/variant/channel plus configured price and available=true. Database constraints protect references, unique records and price precision; the service checks reference activation before pricing/enabling. Disabling remains allowed when parents are inactive. No physical-delete endpoints exist. Changing a category does not bump child item versions, but writes recheck current category activation under the common lock.

Menu audit is configuration history, not an order ledger. Counter order items now snapshot item/variant names, channel and sold unit price; future structured modifiers will need snapshots too; current menu rows cannot reconstruct historical sales. Migration 004 introduced no modifier or order tables; Orders arrives in 008.

## Menu UX migration and aggregate transactions — 005

Migration 005 drops only obsolete `sort_order` columns from menu_categories, menu_items, item_variants and sales_channels. PostgreSQL drops the indexes depending on those columns; replacement indexes cover category/item creation order and variant parent/creation order. No category, item, variant, channel, price or availability rows are deleted, reset or seeded. Existing IDs, creation times, version values and all immutable audit snapshots are preserved; historical audit JSON may still contain the old sortOrder field and is intentionally not rewritten. No applied migration was edited.

Admin categories/items: created_at DESC, id DESC. Operational categories/items: created_at ASC, id ASC. Variants: created_at ASC, id ASC. Sales channels: created_at ASC, code ASC. Variant created_at defaults to clock_timestamp() so multiple portions inserted in a single transaction follow their input sequence; existing timestamps are untouched. No ordering fields remain in current public contracts or UI.

The complete-dish POST/PUT uses the same advisory lock, actor/session recheck and optimistic aggregate version. It validates all nested references/names/prices before writes, writes metadata and nested changes on one connection, and appends one final before/after audit record. Missing stored variants/channel settings are rejected; deactivation retains records. Failure at any point rolls back even already-written metadata/portions. Granular APIs continue to use the same transaction and version protections.

## Menu images — 006_menu_images.sql

Adds `menu_images`: UUID primary key, restrictive uploaded_by user FK, width/height checked 1–1024, byte_size checked 1–2097152, created_at; indexes on creation time and uploader/creation time. Adds nullable `menu_items.image_key` with a restrictive FK and a partial unique index, allowing at most one dish per image. Existing items receive null without rewriting prices, activation, identities, timestamps or audit history. Applied migrations are unchanged; there are no image binaries in PostgreSQL.

Image attachments are part of the full-dish versioned save and before/after menu audit. Omitting imageKey preserves the existing reference; null removes it. A new reference must identify the caller's unassigned staged upload with a local file. Another manager may preserve/remove the current image or replace it with their own upload. Menu lock 742019323 serializes upload metadata, item edits and cleanup; FK constraints and referenced-file checks protect active files. The service limits each uploader to 20 unassigned images. Staged files older than 24 hours and untracked old files are eligible for explicit cleanup; attached images are retained regardless of age. See Architecture for filesystem failure/backup semantics.

## Counter operational capability — 007_counter_availability.sql

Adds menu.availability.manage and grants OWNER/MANAGER/CASHIER explicitly. No existing menu or media data changes; no new table/column. Operational toggles use existing variant_channel_settings.available for COUNTER, existing parent versions, menu audit and advisory lock 742019323. They do not touch active fields, prices or other channels. Staff HTTP mutations now also revalidate session existence/expiry after advisory lock 742019322; all existing constraints remain authoritative.

## Orders Core — 008_orders_core.sql

Adds order_daily_tokens (business_date PK, positive last_token), orders, order_items and order_status_history. Existing users/menu/images/audit rows are unchanged. KITCHEN gains orders.read.

Orders: UUID PK; source FK to sales_channels (currently constrained COUNTER); checked lifecycle status; date/token unique; confirmed_by user FK; creator/request_id unique plus SHA-256 request hash; queued_at; checked exact subtotal/tax/grand total and zero discount/rounding adjustment; tax rate/label/timezone/mode/rounding snapshots. Queue index `(status,queued_at,id)` and actor/time index. Amounts use numeric plus scale/range checks instead of silently rounding typmods. Grand total equals subtotal+tax; tax equals round(subtotal*rate/100,2).

Order items: UUID PK, restrictive order/menu/variant FKs, position unique per order (1–100), checked quantity 1–99, item/kitchen/variant name snapshots, exact unit price/line subtotal and up to 500-character instruction. Variant/item matching is checked by insert trigger; line subtotal equals quantity×price. Order status history: UUID PK, order/actor FKs, checked from/to transition, timestamp and nonblank reason; indexed by order/time/ID. Updates/deletes are forbidden. The initial history insert seals the aggregate; insert guards reject subsequent item/history appends. Deferred validation forbids committing an unsealed order. Deferred constraints require 1–100 items, sum matching subtotal and initial DRAFT→QUEUED history with the confirmation actor/time.

All confirmed orders are currently immutable at database level, including status. The next lifecycle migration must replace only the appropriate guard with transactional transition/history enforcement. No cancellation or token recycling operation is exposed. Daily counter updates must increase and deletion is forbidden, preventing token reuse. Token allocation uses atomic daily UPSERT inside confirmation; the menu advisory lock serializes validation/snapshots against catalog writes. Failed confirmation rolls back allocation. Confirmed records retain keys permanently. No payment/customer tables or fake financial transactions are created.
