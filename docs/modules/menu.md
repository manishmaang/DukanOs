# Menu

## Purpose and current implementation

A single-restaurant catalog for future POS/Kitchen consumers: category → menu item → flexible sellable variants → channel price/availability. Backend APIs, Admin management, and a read-only POS preview are implemented. Ordering is not implemented.

## Model and lifecycle

- Categories: stable UUID, name, optional description, display order, active state, timestamps, version.
- Items: UUID, category, name, description, optional kitchen display name, display order, active state, timestamps, aggregate version. No item-level price.
- Variants: UUID, item, arbitrary name and optional short label, display order, active state, timestamps. Every item retains at least one variant, even if all variants are inactive. Names are case-insensitively unique within the item, never globally.
- Channels: configuration rows with stable code, name, activation and order. COUNTER/ZOMATO/SWIGGY initially. New codes can be introduced by migration without schema redesign.
- Channel settings: one variant/channel price, independent available flag, timestamps. Saving a price preserves availability; newly priced entries default unavailable. No delete endpoints; deactivate obsolete entries.

Category names are case-insensitively unique; item names are unique within categories. Names are trimmed. Display order is nonnegative; ties use name and ID. See DATABASE for exact fields, constraints and indexes.

## Prices and availability

INR prices are decimal strings, normalized to two fractional digits; PostgreSQL checked numeric rejects negative values, nonfinite values, excessive precision and values above ₹999999999999.99. JSON numbers/exponent notation are rejected. No floating-point conversion or financial arithmetic.

A sellable variant requires: active category AND item AND variant AND sales channel AND a configured price AND channel available=true. Operational responses omit unavailable variants and then empty items/categories. Administrative aggregates retain inactive/unavailable configuration. Price changes and enabling availability reject inactive references. Disabling is permitted while ancestors are inactive. Reactivation restores saved availability flags; review them before reactivating.

To disable an entire item on one channel, disable that channel for each of its variants. Item/variant activation provides a quick global stop. No inventory, timed schedules, cloud sync or integration calls exist.

## APIs

All routes use the repository's `/api` prefix. Mutations require `X-DukanOS-Request: 1` and a live session. DTOs reject unknown fields.

| Method and path (under /api/menu)                 | Capability  | Contract                                                                                                     |
| ------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| GET `?channel=COUNTER`                            | menu.read   | Selected channel and sellable categories/items/variants with price strings; invalid/inactive channel is 400. |
| GET `/channels`                                   | menu.read   | Configured channels, including inactive ones.                                                                |
| GET `/admin`                                      | menu.manage | Categories, items with nested variants/channel settings, and channels in one response.                       |
| GET `/categories`                                 | menu.manage | All categories.                                                                                              |
| POST `/categories`                                | menu.manage | name; optional description, sortOrder, active.                                                               |
| PATCH `/categories/:id`                           | menu.manage | version plus changed category fields.                                                                        |
| GET `/items`                                      | menu.manage | All administrative item aggregates.                                                                          |
| GET `/items/:id`                                  | menu.manage | One item aggregate.                                                                                          |
| POST `/items`                                     | menu.manage | categoryId, name, variants (1–30 initial definitions); optional description, kitchenName, sortOrder, active. |
| PATCH `/items/:id`                                | menu.manage | version plus changed item fields.                                                                            |
| POST `/items/:id/variants`                        | menu.manage | itemVersion, name; optional displayLabel, sortOrder, active.                                                 |
| PATCH `/variants/:id`                             | menu.manage | itemVersion plus changed variant fields.                                                                     |
| PUT `/variants/:id/channels/:code/price`          | menu.manage | itemVersion, price decimal string. Atomic create/update.                                                     |
| PATCH `/variants/:id/channels/:code/availability` | menu.manage | itemVersion, available boolean. Existing price required.                                                     |

Item/variant/channel mutations return the updated item aggregate, including its new version. Category mutations return the updated category. Child edits use the parent item's current `itemVersion`, not a variant version. Conflicts return 409 MENU_VERSION_CONFLICT; duplicate scoped names return MENU_DUPLICATE. Other business errors include INVALID_MENU_PRICE, MENU_REFERENCE_INACTIVE, MENU_PRICE_REQUIRED, MENU_CHANNEL_INVALID and MENU_CHANNEL_INACTIVE. Missing items/categories/variants return 404 with specific codes.

## Permissions and concurrency

OWNER/MANAGER: menu.read + menu.manage. CASHIER/KITCHEN: menu.read. DISPATCH: neither by default. These are database grants, not hard-coded role authorization. Current permissions are checked by guards and rechecked inside write transactions with session validity. Menu writes serialize under a PostgreSQL transaction advisory lock; expected aggregate versions prevent stale overwrites. Child database triggers increment parent versions. Repeatable-read catalog snapshots prevent mixed read models. Audit inserts are atomic with successful configuration mutations and record actor/time/before/after.

## Database tables and dependencies

menu_categories, menu_items, item_variants, sales_channels, variant_channel_settings, menu_audit (migration 004). Uses shared PostgreSQL infrastructure and local Auth capabilities. Public MenuCatalog/OperationalMenu contracts live in shared-types; repository rows are mapped explicitly. No events are emitted or consumed.

## Frontend

Admin includes category creation/editing, item creation/editing, variant creation/editing, sort/activation controls and a dynamic channel pricing comparison table. Save availability separately from price. Refresh retrieves current versions after conflicting edits. POS displays available categories, items, variants and channel prices only; it cannot create orders or tickets. Kitchen remains a placeholder with API read capability available for future use.

## Modifiers deferred

Reusable menu-side modifiers are deliberately deferred to keep this milestone focused. Proposed model: modifier_groups (name, active, sort order, selection minimum/maximum), modifier_options (group FK, name, active, sort order), item_modifier_groups (item/group unique assignment). Options would have stable IDs; optional future option/channel price records can add charges without changing base variant pricing. Selection counts, mutually exclusive instructions, eligibility and paid-option semantics must be resolved with the order design. Free-text instructions will remain independently supported by future orders. No modifier tables, assignment UI or selection/pricing behavior is claimed as implemented.

## Historical and integration boundary

Future order items must snapshot sold item/variant names, price, channel and instructions/modifiers. Current menu configuration and its audit trail do not replace immutable sale snapshots. External item → internal variant mappings belong to provider adapters; no Zomato/Swiggy payloads or API calls enter Menu.

## Verification and remaining work

`npm run check` and `npm run test:integration` cover HTTP validation, permissions, names, price precision, availability, activation, database constraints and concurrent price updates. Integration tests use an isolated menu_test_* PostgreSQL schema and remove only their own data. A local Chromium smoke check also verified OWNER form-based menu creation/pricing, MANAGER administration, CASHIER preview, KITCHEN administration denial and inactive filtering using an isolated test schema. Non-local browser requests were blocked; no external requests occurred. See README for manual menu creation; no production menu seed exists.

Remaining: modifiers, optional bulk channel controls, search/pagination if menu size requires it, and future order-time validation/snapshots. Hosting, TLS and backup readiness remain deployment work. No disconnected-browser writes or WAN/cloud synchronization exists; LAN/server/PostgreSQL must remain up.
