# PostgreSQL database

## Implemented schema

Scaffold infrastructure, Auth/Users, Menu, Orders, Bills and Payments tables are implemented. Other domain entities below remain proposed, **not migrated tables**.

### schema_migrations

Created transactionally by the migration runner. `name text` primary key, `checksum text NOT NULL` (SHA-256), `applied_at timestamptz NOT NULL DEFAULT now()`. Tracks immutable migration files. No foreign keys or secondary indexes.

### app_metadata

Migration `001_foundation.sql`: `key text` primary key with nonempty check, `value text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`. Seeds `application = DukanOS`. No financial semantics, foreign keys, or secondary indexes.

## Migration contract

Run `npm run db:migrate` from the repository root. A transaction-scoped advisory lock serializes runners before ledger creation. All pending SQL and ledger inserts commit atomically. Checksums reject edits to applied migrations; missing applied files and out-of-order additions fail. Use zero-padded ascending filenames. SQL files must not contain transaction control or operations forbidden inside transactions (such as concurrent index creation). No automatic down migrations: restore a backup or ship a reviewed forward correction. Never rewrite applied migrations.

## Proposed domain model

Use UUID primary keys, timestamptz timestamps, explicit FKs and restrictive deletion for historical/financial records. Only introduce tables with their implementing feature and tests.

| Module            | Proposed entities and integrity                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders extensions | Future immutable amendments/revisions; base Orders schema is implemented below.                                                                                                     |
| Kitchen           | order-owned queue timestamps and audited priority records; derive aggregation from active item revisions without losing order linkage                                               |
| Customers         | customers (name and indexed normalized mobile; do not assume shared family phone numbers are unique), optional preferences and communication consent                                |
| Credit            | credit_accounts (unique customer FK, eligibility and optional nonnegative limit), ledger_entries (account/order/payment linkage, signed numeric amount, unique operation reference) |
| Integrations      | provider_orders (unique provider/external ID, internal order FK), external item/modifier mappings, processing records for deduplication                                             |
| Reports           | initially queries/projections over source records; no independent sales ledger or duplicate financial authority                                                                     |

Future financial values are proposed as numeric(14,2) in PostgreSQL and strings in JSON. Menu uses checked numeric instead, to reject excessive scale without silent rounding. Orders arithmetic uses BigInt paise; currency is INR and exclusive configurable tax is rounded HALF_UP once to paise. Credit entries increase debt for purchases and decrease it for repayments/reversals. Posted transactions are append-only, with linked reversals. Do not count repayments as sales.

## Planned transactional boundaries

- Confirm Counter order (implemented): validate availability/prices, persist sale/tax snapshots, daily token, status history and request identity atomically. No tender or credit debt is created.
- Amend order: lock order, verify expected version/status, append item revisions and amendment reason, compute exact delta, record linked payment/refund/credit adjustment atomically as applicable. External payment calls require a separate durable state machine, not a long-held DB transaction.
- Future refund: lock bill and legitimate amendment entitlement, check remaining refund due and prior compensating entries, insert CASH-only refund with unique operation key.
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

Order items: UUID PK, restrictive order/menu/variant FKs, position unique per order (1–100), checked quantity 1–99, item/kitchen/variant name snapshots, exact unit price/line subtotal and up to 500-character instruction. Variant/item matching is checked by insert trigger; line subtotal equals quantity×price. Order status history: UUID PK, order/actor FKs, checked from/to transition, timestamp and nonblank reason; indexed by order/time/ID. Updates/deletes are forbidden. The initial history insert seals the aggregate; insert guards reject subsequent item appends; migration 009 allows only validated lifecycle history appends. Deferred validation forbids committing an unsealed order. Deferred constraints require 1–100 items, sum matching subtotal and initial DRAFT→QUEUED history with the confirmation actor/time.

Confirmed financial fields and items remain immutable. Migration 009 replaces the status guard with audited START/READY enforcement. No cancellation or token recycling operation is exposed. Daily counter updates must increase and deletion is forbidden, preventing token reuse. Token allocation uses atomic daily UPSERT inside confirmation; the menu advisory lock serializes validation/snapshots against catalog writes. Failed confirmation rolls back allocation. Confirmed records retain keys permanently. Migration 008 created no payment/customer tables or fake financial transactions; migration 012 adds the parent bill ledger described below.

## Kitchen lifecycle — 009_kitchen_lifecycle.sql

No new tables, columns, permission grants or data backfill. Adds unique order_status_history(order_id,to_status), replaces the order update/delete guard and history insert guard, and adds an AFTER history insert trigger. Initial DRAFT→QUEUED must match the confirmation actor/time. Later inserts allow only current QUEUED→PREPARING or PREPARING→READY, nondecreasing history time, and FIFO queued_at/id for START under advisory lock 742019323. After insertion, status changes in the same transaction; order updates require matching history and forbid all non-status changes. Updates/deletes of history/items and subsequent item appends remain blocked. PreparingAt is derived from the unique PREPARING history record. Existing order queue/history indexes support reads.

Kitchen commands take the shared restaurant/menu/confirmation lock before actor/session/order locks. Recheck session and kitchen.update after waiting. The serialization boundary prevents duplicate transitions, FIFO write skew and uncommitted confirmations overtaking the selected next token. Failed history/status writes roll back together. No PREPARING→CANCELLED, READY→COMPLETED or rewind is enabled in this migration. Like all integrity triggers, schema-owner administration can bypass enforcement and must not disable guards in application workflows.

## Kitchen Counter capability — 010_kitchen_counter_availability.sql

Adds only role_permissions(KITCHEN, menu.availability.manage), using ON CONFLICT DO NOTHING. No table/column/trigger changes, defaults, catalog rewrite, history update or data reset. Existing KITCHEN menu.read, kitchen.read/update and orders.read remain; menu.manage and orders.create are not granted. Existing users, orders, prices, images and audit/history records are preserved. The Menu transaction and before_value/after_value audit continue to own Counter availability mutations.

## Dispatch lifecycle — 011_dispatch_handoff.sql

Replaces only protect_order_lifecycle and validate_order_transition to additionally accept READY→COMPLETED. Existing triggers atomically apply status from validated history; unique order_history_destination_idx continues to prevent duplicate destination history. Financial/item immutability, initial sealing, actor FKs, append-only history and FIFO START remain intact. Existing rows (including READY orders), IDs, timestamps, menu/images/users/audits and role grants are untouched. No new tables or columns.

Adds partial order_history_ready_queue_idx(occurred_at,order_id) WHERE to_status='READY'. Dispatch joins READY orders to their unique READY history record and sorts by its timestamp then order UUID across dates. Completion time and actor are derived from the unique COMPLETED history row, avoiding a redundant completed_at column. The shared transaction lock/session/capability checks apply before completion. See decision 013 and Dispatch for errors and rollback semantics.

## Bills and Payments — 012_bills_payments.sql

- bills: UUID PK, unique business_date/bill_number, DINE_IN/TAKEAWAY for new bills, explicit legacy marker with null service only for imported orders, 80-character reference, OPEN/CLOSED, opening and closing actors/timestamps. Closing is guarded against unsettled balance/active rounds; metadata/history cannot be rewritten or deleted.
- bill_daily_numbers: date PK and positive last_number, allocated atomically inside first order confirmation, with guards preventing rewind/deletion. Bill numbering is independent of order_daily_tokens.
- orders.bill_id: NOT NULL restrictive FK, index (bill_id,queued_at,id). Each old order maps to one marked legacy bill; only this new relationship is backfilled. Existing fields/history remain unchanged, no payment invented. New insert requires open bill; existing immutable-order guard protects bill membership.
- payments: UUID PK; restrictive bill/user FKs; COLLECTION/REFUND type; CASH/UPI method; positive checked numeric <=999999999999.99 and scale <=2; REFUND implies CASH; actor/time; request UUID/hash with actor-scoped uniqueness; bill/time/id index. Trigger rejects updates/deletes, closed-bill/excess collections and all currently unimplemented refund inserts.
- bill_balances view: exact sums over confirmed order snapshots and payment ledger; total/collected/refunded/net_paid/amount_due/refund_due, without persisted derived payment status.
- Takeaway history trigger checks bill due before READY→COMPLETED, preserving existing order history/FIFO guards. Legacy null-service and Dine In are not payment-gated.
- Grants bills.read/manage and payments.read/collect to OWNER/MANAGER/CASHIER; removes KITCHEN orders.read. Kitchen keeps operational read capability and receives no financial data.

All application commercial writes follow lock 742019323, actor/session, then bill/order rows as required. Repeatable-read projections return consistent bill/queue snapshots. Future amendments must derive an effective revised total through explicit immutable records; ledger collections stay intact. Cash-only refunds require a later authorized migration/workflow, not manual row edits.

## Confirmation provenance and operational alerts — 013_confirmation_alerts.sql

Forward-only additions preserve existing records. payments gains nullable confirmation_order_id (orders FK), partial unique (confirmation_order_id,method), and an insert guard requiring matching bill/confirming actor. Existing standalone receipts remain null and immutable. order_items gains unique(order_id,id) for the timer's composite association FK.

bill_reminders has bill_id PK/FK, checked interval_minutes 1–1440, nullable next_due_at, creator/creation time, last manual updater/update time and positive version. Insert/update requires a Dine In bill; an active timestamp requires open positive due. Order/payment/close triggers transactionally pause or resume schedules as balances change, retaining the preference. Version increments on updates and snooze uses expected version. Partial due index supports active reads. Recurrence derives from the anchor, without occurrence rows or GET side effects.

kitchen_timers has UUID PK, optional order/item restrictive FKs (composite ensures ownership), checked nonblank label <=120, integer duration 60–86400, exact started/due relationship, ACTIVE/ACKNOWLEDGED/CANCELLED, creator/request UUID/hash uniqueness and resolution actor/time consistency. Active due_at/id index supports polling. Triggers prohibit identity/time/duration edits, terminal rewrites/deletes and premature acknowledgement. API additionally requires associated orders to be currently QUEUED/PREPARING at creation. Due state derives from timestamps.

Adds bills.reminders.read/manage for OWNER/MANAGER/CASHIER and kitchen.timers.read/manage for OWNER/MANAGER/KITCHEN; multi-role unions unchanged. New financial and alert mutations retain restaurant lock 742019323, live actor/session checks and shared-connection transactions. No existing migration is edited; no seed, data reset or historical settlement inference occurs.
