# Orders

## Purpose and current implementation

Counter POS confirmation is implemented. The browser builds an editable draft; one transactional API call creates a QUEUED order with permanent UUID, daily token, sale snapshots and actor history. Kitchen START/READY and Dispatch completion are implemented through Orders-owned lifecycle commands. No draft rows, payments, customers, cancellations or amendments are exposed yet.

## Lifecycle and immutability

Policy: DRAFT → QUEUED → PREPARING → READY → COMPLETED. DRAFT/QUEUED may transition to CANCELLED in a future authorized cancellation workflow; PREPARING cancellation requires a separate business decision. Terminal states have no outgoing transitions. Implemented transitions are DRAFT → QUEUED → PREPARING → READY → COMPLETED. Migration 009 permits only audited Kitchen START/READY after confirmation, using append-only history to apply status atomically. Financial snapshots and all item fields remain immutable; later item appends and history rewrites remain forbidden. Migration 011 additionally permits audited Dispatch completion. There is no generic status PATCH, cancellation or undo API. See [Kitchen](kitchen.md) for FIFO, locking and transition errors.

## Confirmation and concurrency

POST /api/orders/counter takes `{requestId: UUIDv4, lines:[{variantId:UUIDv4, quantity:1..99, instruction?:string}]}`. One to 100 lines; instructions at most 500 characters, trimmed plain text. Unknown fields, authoritative client prices, noninteger quantities and null instructions are rejected. Menu resolves active category/item/variant/COUNTER channel, configured price and availability. ITEM_NOT_AVAILABLE identifies the affected 1-based line and available name or variant ID. No partial order or token is committed on failure.

The transaction takes Menu's advisory lock 742019323, locks the actor row, rechecks live session/capability, checks replay, resolves current Counter data, calculates exact totals, allocates token, inserts order/items/history, then commits. The session row is share-locked through commit. Menu price/availability writes and confirmations serialize; whichever obtains the lock first defines the observed state. This intentionally broad lock suits one small restaurant. No external calls occur inside confirmation. Direct database administration must coordinate with this lock; application workflows always do.

## Tokens and business date

UUID is the permanent identity. `(business_date, token_number)` is unique. `RESTAURANT_TIMEZONE` defaults to Asia/Kolkata; the business date is the PostgreSQL server clock's calendar date in that timezone, resetting at local midnight (no custom shift cutoff). Capture time/date together after validation. Atomic INSERT…ON CONFLICT increments order_daily_tokens and returns the token, in the same transaction. First committed confirmation on a new date receives 1. Failed transactions consume no committed token; committed tokens are never recycled. Cancelled-token reuse remains forbidden when cancellation is implemented. Date accompanies token lookup to avoid cross-day ambiguity. Keep restaurant server time correct and coordinate timezone changes at a business boundary.

## Idempotency

A browser-generated UUID requestId is unique per authenticated creator. SHA-256 of the ordered normalized lines binds the key to the payload. Same actor/key/same payload returns the original snapshot even after menu/tax changes; different payload returns IDEMPOTENCY_CONFLICT. Different actors have separate key scopes. Records/keys are retained with orders, without automatic expiry. Validation failures roll back and do not reserve a key. The shared transaction lock and database unique constraint prevent simultaneous duplicate creation.

Before sending, POS stores the exact request in per-user sessionStorage. While outcome is uncertain, editing/new submissions are locked and Retry sends the same request. Page reload in the same tab recovers that request. Success clears it and shows token/total; New Order explicitly starts the next draft. Ordinary unsent drafts are memory-only; closing the tab loses them. Closing a tab with an ambiguous request also loses its tab-scoped recovery data: use the order read API to check before starting a replacement. No disconnected-browser queue is implemented.

## Sale snapshots, money and tax

Items retain menu/variant FKs plus item name, kitchen name (fallback item name), variant name, unit price, quantity, line subtotal and instruction snapshots. Reads never use current names/prices. Lines with different instructions remain separate. The UI merges added lines only when menu item ID, variant ID, exact Counter unit price and trimmed, case-sensitive instruction match; edits do not automatically consolidate lines. The server preserves submitted line boundaries.

All money uses checked PostgreSQL numeric and decimal JSON strings. Backend and frontend estimates use BigInt paise, never binary floating-point. Subtotal is the sum of unit price × quantity. Discount and rounding adjustment are exactly zero. No nearest-rupee rounding occurs.

Local server environment configuration (restart required): ORDER_TAX_RATE is a plain percentage 0–100 with at most two fractional digits, default 0; ORDER_TAX_LABEL defaults to Tax. Only order-wide EXCLUSIVE tax is implemented: tax = subtotal × rate / 100, rounded once HALF_UP to paise. Grand total = subtotal + tax. Rate, label, timezone, mode, rounding method and amounts are stored on each order. Configuration changes do not affect prior orders. This is configurable arithmetic, not an assertion about applicable tax law. Inclusive/per-item/multiple tax components and tax administration UI are deferred. Production operator must supply applicable billing configuration. POS shows estimated totals; current server prices/configuration apply at confirmation and returned totals are authoritative.

Payment state is independent and not yet persisted or computed; there are no payment transactions or PAID claims. Walk-in orders need no customer. Future Payments can reference order UUID; a customer FK can be added when Customers exists. No speculative customer table/reference is created.

## APIs and capabilities

All routes below have /api prefix and normal authenticated session/mutation-header requirements.

| Route                                                        | Capability    | Result                                                             |
| ------------------------------------------------------------ | ------------- | ------------------------------------------------------------------ |
| POST /orders/counter                                         | orders.create | ConfirmedOrder (201, including replay)                             |
| GET /orders/configuration                                    | orders.create | Current timezone and tax configuration for estimates               |
| GET /orders/:id                                              | orders.read   | Immutable sale and current lifecycle snapshot                      |
| GET /orders/tokens/:date/:token                              | orders.read   | Exact business-date/token lookup                                   |
| GET /orders?status=QUEUED&businessDate=YYYY-MM-DD&after=UUID | orders.read   | `{orders,nextCursor}`, 100 results in queued_at/id ascending order |

List filters are optional; omit businessDate for pending work spanning midnight. Pass nextCursor as after with the same filters for the next page. Current persisted statuses are QUEUED, PREPARING, READY and COMPLETED; later lifecycle values remain reserved. No history mutation API is exposed. Public shared contracts contain no request fingerprint or persistence credentials.

OWNER/MANAGER/CASHIER already have orders.create/read. Migration 008 additionally grants orders.read to KITCHEN for the next queue consumer, without order creation or menu administration. Existing kitchen.read/update grants authorize the implemented Kitchen workspace/actions. DISPATCH uses its dedicated operational projection, without generic orders.read access. Multi-role unions work normally.

## Kitchen boundary

Kitchen consumes operational-only projections via GET /api/kitchen/orders and /production, with no financial fields. Orders exports OrderLifecycleService for explicit START/READY commands. A transaction sharing confirmation's advisory lock enforces FIFO, locks/rechecks actor session and capability, validates canTransition and appends actor/time/reason history. Database triggers independently enforce FIFO and apply status without permitting financial changes. Preparing time is derived from history. Kitchen polls the combined read snapshot every two seconds and refetches after actions/reconnect. Generic order read endpoints remain available with their existing financial contracts; Kitchen UI uses its dedicated projections. See [Kitchen](kitchen.md).

## Verification

Unit tests cover exact paise/tax rounding, config validation, lifecycle policy and cart merge rules. PostgreSQL integration covers snapshots, permissions/strict input, concurrent tokens, replay/conflict, availability locking, immutable records, reads and tax changes. Browser regression exercises the existing menu/media/availability UI plus cashier cart confirmation, a lost response and page reload with same-request recovery. All fixtures use isolated PostgreSQL schemas; existing operational data is not seeded or rewritten.

Regression coverage includes strict API/transaction behavior, exact money and cart merge rules, independent instruction serialization and browser confirmation into PostgreSQL. Browser fixtures block external requests and preserve actual restaurant data. Migration 008 preservation was verified when Orders Core shipped; the cart UX refinements introduce no migrations.

## POS dish selection

The existing POS categories, search, cards, images and cart are retained. Opening a dish shows all active/priced Counter portions together, including disabled sold-out rows for restoration. Each quantity starts at zero and uses 44px −/+ controls capped at 99. One Add action inserts every selected sellable portion; zero quantities are excluded. The selection amount uses exact paise and is a pre-tax estimate. The cart continues to show configured tax and confirmation remains authoritative.

Each portion has its own independent instruction, initially empty. Add instruction opens a textarea for that portion only; Done collapses it to a plain-text Note summary with Edit and Remove note. No shared instruction is copied across portions. Typing updates the portion draft immediately, so Add includes the latest note even if Done was not clicked. Notes retain the existing 500-character bound and plain-text semantics. Different variants/instructions remain separate; matching lines merge under the existing rule. The batch is applied atomically in browser state: exceeding a cart/line limit leaves the entire cart unchanged. Cart lines remain editable separately for multiple customizations of the same portion.

Desktop dialog: maximum 1040px width, viewport minus 40px margins, compact 210px-high image beside portion controls. Header and action footer stay visible while the body scrolls when needed. At ≤800px, the body stacks with a 100×80px thumbnail and near-full viewport width. Selected rows are highlighted. Availability actions remain secondary, permission-gated controls. Closing with × or Escape discards only unadded selection. A newly unavailable selected portion is excluded and cleared with an explanation; backend availability checks remain unchanged.

## Current Order panel

The POS-only application container has a 1480px maximum width. From 900px, menu/cart remain side by side (approximately 2:1 on desktop, balanced columns with a 340px cart at smaller landscape widths). Below 900px a persistent View Order button opens the same live cart in a native dialog; other application workspaces retain their previous width. Current Order has a fixed header, independently scrollable line list and a persistent totals/confirmation area. On short keyboard-sized viewports the full cart scrolls so controls cannot be clipped. Back to dishes and New Order return to menu browsing; orientation changes preserve draft and pending confirmation state. Empty carts show a compact prompt without disabled confirmation controls. Subtotal and configured tax remain visible; the estimated Total is emphasized. Pricing details expand on demand and explicitly state that confirmation uses current prices and collects no payment.

Cart lines carry stable frontend IDs and menu item IDs for editing and grouping. A dish heading groups related rows visually, without altering their original order or collapsing separate backend lines. Variant, quantity, line price and Remove stay compact. Add instruction/Edit/Remove note target only the selected line; empty textareas are not rendered except during editing. Typing edits that line immediately; Done trims and closes the editor. Different instructions or prices remain separate on subsequent additions. Editing alone never automatically merges lines.

The confirmation serializer explicitly sends only variantId, quantity and each line's own instruction, alongside requestId. UI IDs/grouping metadata are omitted. Existing authoritative pricing, availability, snapshots, idempotency and transaction boundaries are unchanged. Draft persistence limitations remain unchanged. Long notes or expanded editors can increase the scrolling list height; totals and Confirm remain outside that list.

## Kitchen usability boundary

Kitchen's configurable late indicator uses total age since queuedAt and never changes FIFO or lifecycle rules. Compact Production instruction breakdowns are presentation-only; original order instructions/source associations remain immutable. Kitchen can change Counter sellability through Menu's existing capability/API. Existing draft carts are not silently removed or repriced; confirmation rejects a newly unavailable portion with ITEM_NOT_AVAILABLE. Already-confirmed orders remain valid Kitchen work regardless of later menu availability.

## Dispatch boundary

Dispatch reads READY-only snapshots ordered by unique READY history time/UUID and calls OrderLifecycleService for READY→COMPLETED under dispatch.complete. The existing lock/session/capability/status checks and history-driven transaction are shared with Kitchen. Migration 011 extends guards; completion records exactly one actor/time/reason history entry, preserves financial/item snapshots and has no payment prerequisite. Completed time is derived from the unique COMPLETED history record. No amendment, cancellation or undo is introduced. See [Dispatch](dispatch.md) for APIs, concurrency, polling and error behavior.

Responsive/touch rules and device verification requirements are maintained centrally in [Responsive UI](../RESPONSIVE_UI.md). Dish dialogs use dynamic/visual viewport bounds and whole-dialog scrolling at very short heights. Phone cart rows put the portion name above large quantity controls and price. No confirmation, idempotency, financial or persistence behavior changes.
