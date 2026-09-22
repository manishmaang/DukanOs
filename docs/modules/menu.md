# Menu

## Purpose and current implementation

A single-restaurant catalog for future POS/Kitchen consumers: category → menu item → flexible sellable variants → channel price/availability. Backend APIs, a dedicated Menu workspace, and a POS browsing and availability controls are implemented. Counter ordering is implemented in Orders.

## Model and lifecycle

- Categories: stable UUID, name, optional description, active state, timestamps, version.
- Items: UUID, category, name, description, optional kitchen display name, active state, timestamps, aggregate version. No item-level price.
- Variants: UUID, item, arbitrary name and optional short label, active state, timestamps. Every item retains at least one variant, even if all variants are inactive. Names are case-insensitively unique within the item, never globally.
- Channels: configuration rows with stable code, name and activation. COUNTER/ZOMATO/SWIGGY initially. New codes can be introduced by migration without schema redesign.
- Channel settings: one variant/channel price, independent available flag, timestamps. Saving a price preserves availability; newly priced entries default unavailable. No delete endpoints; deactivate obsolete entries.

Category names are case-insensitively unique; item names are unique within categories. Names are trimmed. Manual display ordering was removed in migration 005. Admin categories/items use `created_at DESC, id DESC`. Operational categories/items use `created_at ASC, id ASC`; adding a dish appends it within its category and renaming does not move it. Variants use `created_at ASC, id ASC` in both read models. New variants created together receive insertion-time timestamps, preserving their entered sequence. Existing timestamp ties use UUID order. Channels use `created_at ASC, code ASC`. None of these policies are user-configurable. See DATABASE for exact fields, constraints and indexes.

## Prices and availability

INR prices are decimal strings, normalized to two fractional digits; PostgreSQL checked numeric rejects negative values, nonfinite values, excessive precision and values above ₹999999999999.99. JSON numbers/exponent notation are rejected. No floating-point conversion or financial arithmetic.

A sellable variant requires: active category AND item AND variant AND sales channel AND a configured price AND channel available=true. The default channel operational response omits unavailable variants and then empty items/categories. The POS Counter view additionally retains sold-out active priced portions. Administrative aggregates retain inactive/unavailable configuration. Price changes and enabling availability reject inactive references. Disabling is permitted while ancestors are inactive. Reactivation restores saved availability flags; review them before reactivating.

To disable an entire item on one channel, disable that channel for each of its variants. Item/variant activation provides a quick global stop. No inventory, timed schedules, cloud sync or integration calls exist.

## APIs

All routes use the repository's `/api` prefix. Mutations require `X-DukanOS-Request: 1` and a live session. DTOs reject unknown fields.

| Method and path (under /api/menu)                 | Capability  | Contract                                                                                                                  |
| ------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET `?channel=COUNTER`                            | menu.read   | Selected channel and sellable categories/items/variants with price strings; invalid/inactive channel is 400.              |
| GET `/channels`                                   | menu.read   | Configured channels, including inactive ones.                                                                             |
| GET `/admin`                                      | menu.manage | Categories, items with nested variants/channel settings, and channels in one response.                                    |
| GET `/categories`                                 | menu.manage | All categories.                                                                                                           |
| POST `/categories`                                | menu.manage | name; optional description, active.                                                                                       |
| PATCH `/categories/:id`                           | menu.manage | version plus changed category fields.                                                                                     |
| GET `/items`                                      | menu.manage | All administrative item aggregates.                                                                                       |
| GET `/items/:id`                                  | menu.manage | One item aggregate.                                                                                                       |
| POST `/items`                                     | menu.manage | categoryId, name, variants (one or more, each optionally containing channels); optional description, kitchenName, active. |
| PATCH `/items/:id`                                | menu.manage | version plus changed item fields.                                                                                         |
| POST `/items/:id/variants`                        | menu.manage | itemVersion, name; optional displayLabel, active.                                                                         |
| PATCH `/variants/:id`                             | menu.manage | itemVersion plus changed variant fields.                                                                                  |
| PUT `/variants/:id/channels/:code/price`          | menu.manage | itemVersion, price decimal string. Atomic create/update.                                                                  |
| PATCH `/variants/:id/channels/:code/availability` | menu.manage | itemVersion, available boolean. Existing price required.                                                                  |

`PUT /api/menu/items/:id` requires menu.manage and saves a complete dish with `version`, `categoryId`, `name`, optional `description`/`kitchenName`/`active`, and `variants`. Each variant has optional existing `id`, name, optional displayLabel/active, and channel settings `{channelCode, price, available}`. `POST /api/menu/items` accepts the same nested configuration without version or existing variant IDs. Both return the saved aggregate. Existing granular endpoints remain available, with all manual ordering fields removed and rejected by strict DTO validation.

Aggregate updates must include every existing variant and every existing priced channel setting; omissions are rejected rather than interpreted as deletion. New variants omit id. Saved portions are deactivated, not removed. Blank new price cells produce no channel record; saved prices cannot be cleared. Duplicate portion names, repeated channel records, foreign variant IDs and invalid prices are rejected. Optional text omitted in a full PUT becomes null; optional active flags retain existing values. Existing active/price flags may be resubmitted unchanged while ancestors are inactive; changing a price or newly enabling a channel requires active final references. This permits pausing a dish without losing saved prices or channel flags.

The service prepares and validates the entire nested configuration before writing, then performs all metadata/variant/channel updates and one audit append in the existing menu transaction. Any validation, database constraint, permission or version failure rolls back the complete save. Read requests after save do not perform further writes. Existing item and variant IDs, creation times and audit history are retained. Optimistic concurrency uses the editing session's captured version even if unrelated category data is refreshed.

Item/variant/channel mutations return the updated item aggregate, including its new version. Category mutations return the updated category. Child edits use the parent item's current `itemVersion`, not a variant version. Conflicts return 409 MENU_VERSION_CONFLICT; duplicate scoped names return MENU_DUPLICATE. Other business errors include INVALID_MENU_PRICE, MENU_REFERENCE_INACTIVE, MENU_PRICE_REQUIRED, MENU_CHANNEL_INVALID and MENU_CHANNEL_INACTIVE. Missing items/categories/variants return 404 with specific codes.

## Permissions and concurrency

OWNER/MANAGER: menu.read + menu.manage + menu.availability.manage. CASHIER: menu.read + menu.availability.manage. KITCHEN: menu.read. DISPATCH: neither by default. These are database grants, not hard-coded role authorization. Current permissions are checked by guards and rechecked inside write transactions with session validity. Menu writes serialize under a PostgreSQL transaction advisory lock; expected aggregate versions prevent stale overwrites. Child database triggers increment parent versions. Repeatable-read catalog snapshots prevent mixed read models. Audit inserts are atomic with successful configuration mutations and record actor/time/before/after.

## Database tables and dependencies

menu_categories, menu_items, item_variants, sales_channels, variant_channel_settings, menu_audit, menu_images (migrations 004–007). Uses shared PostgreSQL infrastructure and local Auth capabilities. Public MenuCatalog/OperationalMenu contracts live in shared-types; repository rows are mapped explicitly. No backend domain events are emitted or consumed; frontend menu-change notifications trigger POS refetching.

## Frontend

OWNER/MANAGER open **Menu** in the main navigation (`/#/menu`); Admin retains staff management and links to Menu. A category-grouped sidebar supports dish/category/portion search, inactive badges, selection and Add Item/Add Category actions. Categories can be created, renamed, described and activated inline as a supporting action.

The same dish form handles creation and editing: name, category, optional description, inline portions, side-by-side INR channel prices, item/portion activation and availability. New dishes start with one editable **Standard** portion; this is only a UI convenience, not a domain enum. Add Variant inserts another row; unsaved rows can be removed, while stored rows can only be deactivated. Optional kitchen display names and portion labels are under secondary details.

One Save Item/Save Changes sends one aggregate write. Channel-wide switches apply to priced active portions; individual cell controls support differing availability. Mixed states are indicated. Newly entered prices do not silently enable availability. Item active=false pauses every channel while preserving channel flags. Prices display without unnecessary whole-rupee decimal zeros using string formatting, never floating-point conversion. Validation identifies the portion/channel and leaves edits intact on failure. Switching dishes or reloading prompts only when it would discard unsaved dish changes; full-page unload also warns. A conflict requires reloading and reviewing the newer version, not automatic overwrite. Drafts are not persisted across sessions.

Desktop/tablet layout uses a menu list beside the editor, with a horizontally scrollable price matrix when needed. Controls have 44px touch targets; narrow screens stack the panels. The save action is below the form and does not obscure prices. POS permits Counter availability changes through a separate operational capability. Menu administration creates no orders; POS confirmation is owned by Orders.

## Modifiers deferred

Reusable menu-side modifiers are deliberately deferred to keep this milestone focused. Proposed model: modifier_groups (name, active, sort order, selection minimum/maximum), modifier_options (group FK, name, active, sort order), item_modifier_groups (item/group unique assignment). Options would have stable IDs; optional future option/channel price records can add charges without changing base variant pricing. Selection counts, mutually exclusive instructions, eligibility and paid-option semantics must be resolved with the order design. Orders now independently supports free-text kitchen instructions. No modifier tables, assignment UI or selection/pricing behavior is claimed as implemented.

## Historical and integration boundary

Implemented Counter order items snapshot sold item/variant names, price, channel and instructions/modifiers. Current menu configuration and its audit trail do not replace immutable sale snapshots. External item → internal variant mappings belong to provider adapters; no Zomato/Swiggy payloads or API calls enter Menu.

## Verification and remaining work

`npm run check` and `npm run test:integration` cover HTTP validation, permissions, names, price precision, availability, activation, database constraints and concurrent price updates. Integration tests use an isolated menu_test_* PostgreSQL schema and remove only their own data. A local Chromium smoke check also verified OWNER form-based menu creation/pricing, MANAGER administration, CASHIER preview, KITCHEN administration denial and inactive filtering using an isolated test schema. Non-local browser requests were blocked; no external requests occurred. The UX regression checks additionally cover obsolete ordering-field rejection, deterministic admin/POS ordering, nested transaction rollback (including a late database failure), concurrency and migration of an existing populated catalog. A Chromium check exercised category creation, one-save Regular/Half/Full pricing, re-open/edit, channel-wide availability, search and tablet layout. See README for manual menu creation; no production menu seed exists.

Remaining: modifiers, pagination if menu size requires it, and future structured modifiers. Hosting, TLS and backup readiness remain deployment work. No disconnected-browser writes or WAN/cloud synchronization exists; LAN/server/PostgreSQL must remain up.

## Menu photos

Photos are optional. OWNER/MANAGER select JPEG, PNG or WebP near the top of the dish editor, preview locally, replace or remove, then save the dish. Removing a photo is a draft change until Save. A staged upload is reused when a save fails so retrying does not keep uploading the same file. Switching away discards the browser draft; abandoned stages are reclaimed after 24 hours. No photo is required for item creation.

- `POST /api/menu/images`: menu.manage; multipart one `image` file, no additional fields. Returns `{key,url,width,height}` for an unassigned upload. At most 20 unassigned images per uploader; further uploads return MENU_IMAGE_LIMIT until stages are attached or expired stages cleaned.
- Existing full-dish POST/PUT accepts optional `imageKey`: omitted preserves, UUID attaches the caller's unassigned stage, null removes. Existing optimistic versions, transactions and audit apply. Granular PATCH does not accept imageKey.
- `GET /api/menu/images/:key`: menu.read; serves attached photos or the uploader's own stage with menu.manage. Invalid keys/unknown files are rejected. Image responses are WebP, inline, nosniff, CSP default-src none, private one-hour immutable cache. Replacement generates a different URL.
- Admin and operational item contracts include `image: {key,url,width,height} | null`. No local paths or original filenames are returned.

Input limit: 5 MiB, 24 million decoded pixels, a single still frame, actual decoded format matching the MIME. Sharp rejects corrupt/unsupported input, auto-orients, resizes within 1024×1024 without enlargement, strips metadata and encodes WebP quality 82, effort 4. Processed files must be at most 2 MiB. Names are generated UUIDs and originals are not retained. Upload processing is serialized under the small-restaurant menu write lock; no external processing service exists.

Storage: `DUKANOS_DATA_DIR/uploads/menu`, default `~/.local/share/dukanos/uploads/menu`. Configure an absolute persistent directory writable by the API user. Run `npm run media:cleanup` for obsolete/unassigned files; stages are kept 24 hours for retry. Cleanup must run with the same database and data directory as the API. Backups require both PostgreSQL and local media. See Architecture for failure consistency.

## Counter visibility investigation and diagnostics

The actual development data showed active Chinese/manchurian with active Half/Full portions and available Counter prices. The stored item `soya chap gravy` in active category `chap` had valid active FULL/HALF portions and available Counter prices ₹250/₹200, but **the item itself was inactive**. Audit recorded creation active at 2026-09-21 11:49:48.086 UTC and a save changing active true→false at 11:50:26.948 UTC. The operational response correctly omitted it. Migration 005 ordering and category rendering were not the cause. Existing operational data is preserved; reactivation is an explicit owner action, not a migration or automatic repair.

Admin items now expose `counterVisibility` (visible, reasons and per-variant reasons) using the same backend predicate as sellable-only channel filtering. This legacy field describes sellability; it does not hide sold-out cards in the newer Counter view. The editor shows live draft guidance for paused items, inactive categories/channels/portions, missing Counter prices and disabled Counter availability. Valid Counter configuration appears after save; unsupported configurations are not made sellable merely to hide an error. A separate old-UI shortcoming was refresh only on entry/manual action; POS now refreshes automatically.

## Visual POS

POS means Point of Sale; Kitchen/KDS remains separate. POS uses `/api/menu/counter`, which includes temporarily sold-out active priced portions with available flags and item versions; `/api/menu?channel=COUNTER` remains sellable-only. Large local photo cards retain written dish names, exact lowest price and portion count. Category buttons and case-insensitive dish/category/portion search work together. Oldest-created-first placement remains stable. Selecting a card opens a keyboard-dismissable portion/price dialog with permission-gated availability controls; the same dialog now selects portions, quantities and instructions for the adjacent order cart. Missing or failed images use a local plate illustration without remote requests. Inactive categories/items/portions and unpriced Counter portions are excluded by the server. Active priced sold-out portions stay visible for restoration.

Refresh occurs on entry, window focus, visibility return, menu-save notification within/across tabs and every five seconds while visible. Replacement URLs avoid stale image caches. Refresh errors clear the listing and show a retry message. This is bounded polling, not instantaneous cross-device push. Browser tests use isolated fixtures, block all non-local requests and exercise upload/replacement/removal, categories/search, Counter prices, automatic refresh and cashier read access and narrow availability controls. Existing business photos/data are not changed by automated tests.

## Operational Counter availability

Migration 007 grants menu.availability.manage to OWNER, MANAGER and CASHIER. KITCHEN retains menu.read only: it has no cashier-facing POS workspace and kitchen workflows are not part of this milestone. DISPATCH gains nothing. Multi-role unions apply normally. The new permission never grants price, configuration, image or other-channel writes.

`GET /api/menu/counter` (menu.read) returns active categories/dishes/portions with configured Counter prices, including available=false portions. Items include the current aggregate version. Other operational channel reads retain their sellable-only contract.

`PATCH /api/menu/counter/items/:id/availability` (menu.availability.manage) accepts `{version,available,variantId?}`. Omit variantId to set every active priced Counter portion of the dish; specify it to change one. Invalid/foreign/inactive/unpriced targets are rejected. No channel selector is accepted. The transaction rechecks session/capability, locks through the existing menu lock, compares version, changes only Counter flags and appends an actor/time/before/after audit. Stale concurrent edits return MENU_VERSION_CONFLICT.

Active/inactive is persistent **menu configuration** controlled in Menu. Available/sold out is persistent **channel sales state** controlled in POS. Sold-out changes do not alter activation, prices, Zomato or Swiggy. Whole-dish Make all available enables all eligible Counter portions; it does not restore a hidden historical subset. Individual controls preserve the other portions. No daily reset, inventory or schedule is implied.

The approved photo-card/category/search layout is retained. Cards show Available, Some portions sold out or Sold out; tap a card for explicit whole-dish/portion buttons. No confirmation is needed. Pending buttons are disabled and success/error feedback is visible. Responses update the local menu immediately; other tabs receive notifications and independent devices refetch within about five seconds while visible, plus request time. Returning from a hidden tab refetches. Failed refreshes remove stale listings; old responses cannot overwrite a pending local mutation.

## Media hardening

Normal replace/remove already committed the new item reference before deleting the old unreferenced file; that behavior is retained and tested. WebP was already quality 82; effort 4 is now explicit. Orientation, maximum 1024 dimensions, metadata stripping, 24-megapixel input and 2-MiB processed limits remain unchanged.

A failed file write/rename attempts immediate temporary-file cleanup. A failed upload metadata transaction now attempts to remove its generated file after rollback. A failed dish save keeps the old valid attachment and retains the staged new photo for retry (up to the existing 24-hour cleanup eligibility). Post-commit unlink failures leave the correct item reference intact and log deferred cleanup. Referenced files are never removed by maintenance.

`npm run media:cleanup -- --dry-run` reports candidate counts without mutation; omit --dry-run to apply. Reports include candidates, removed and deferred; deferred failures give a nonzero CLI exit code. Only UUID-named media confirmed unreferenced under the menu lock are eligible. No startup cleanup or automatic removal of existing business images occurs.

All Menu body/query/route/multipart boundaries are included in [the validation audit](../API_VALIDATION.md). Active flags reject null, full dishes allow at most 100 portions and 100 channel entries each, versions are positive PostgreSQL integers, and channel codes follow the configured grammar. Database uniqueness, FK, money and atomic-save protections remain unchanged.

Verification uses PostgreSQL fault injection for failed file rename/unlink and metadata insertion, validates safe dry-run, and checks actual generated files before/after replacement. A deterministic 1600×1200 JPEG fixture reduced from 545,574 to 100,072 bytes (about 82%) after normalization; this illustrates existing quality-82 compression, not a guaranteed ratio for food photos. Two independent Chromium cookie jars verify cashier toggles and manager propagation without tab broadcasts; all browser traffic is restricted to the local installation.

## Orders boundary

Orders calls Menu application methods on its transaction connection to acquire the common menu lock and resolve Counter sellability. Current authoritative prices are snapshotted only at confirmation; menu edits never rewrite old orders. Price/availability writes and order confirmations serialize. No inventory reservation or provider call is introduced.

## POS portion naming and multi-selection

POS renders the stored variant name as the primary portion label, consistently with cart/order snapshots; it no longer replaces that name with displayLabel. Read-only investigation of the restaurant database and the Counter service projection found FULL / ₹250 with displayLabel SCG-H and HALF / ₹200 with displayLabel SCG-F on soya chap gravy. The API returned each name/label/price on the correct variant UUID. The previous UI preferred displayLabel for the row heading while the Choose button used name, exposing conflicting stored labels. No variant/price IDs were swapped in rendering. The presentation is corrected without rewriting business data or guessing the intended meaning of saved codes; labels remain editable in Menu administration.

The dialog now supports quantities for multiple portions and one batch Add, shared/per-portion kitchen notes, compact sold-out controls, a smaller image and a persistent action footer. See Orders for cart behavior. Menu APIs, pricing, availability enforcement, images and audit semantics are unchanged; no migration is introduced.
