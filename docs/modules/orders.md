# Orders

## Purpose and current implementation

Counter POS confirmation is implemented. The browser builds an editable draft; one transactional API call creates a QUEUED order with permanent UUID, daily token, sale snapshots and actor history. No draft rows, payments, customers, kitchen actions, cancellations or amendments are exposed yet.

## Lifecycle and immutability

Policy: DRAFT → QUEUED → PREPARING → READY → COMPLETED. DRAFT/QUEUED may transition to CANCELLED in a future authorized cancellation workflow; PREPARING cancellation requires a separate business decision. Terminal states have no outgoing transitions. This milestone implements only DRAFT → QUEUED. PostgreSQL blocks updates/deletes of confirmed orders, items and history, and blocks later item/history appends. Kitchen must replace the order update guard with tightly validated, audited lifecycle transitions in a new migration; it must preserve financial/item immutability. There is deliberately no generic status PATCH API.

## Confirmation and concurrency

POST /api/orders/counter takes `{requestId: UUIDv4, lines:[{variantId:UUIDv4, quantity:1..99, instruction?:string}]}`. One to 100 lines; instructions at most 500 characters, trimmed plain text. Unknown fields, authoritative client prices, noninteger quantities and null instructions are rejected. Menu resolves active category/item/variant/COUNTER channel, configured price and availability. ITEM_NOT_AVAILABLE identifies the affected 1-based line and available name or variant ID. No partial order or token is committed on failure.

The transaction takes Menu's advisory lock 742019323, locks the actor row, rechecks live session/capability, checks replay, resolves current Counter data, calculates exact totals, allocates token, inserts order/items/history, then commits. The session row is share-locked through commit. Menu price/availability writes and confirmations serialize; whichever obtains the lock first defines the observed state. This intentionally broad lock suits one small restaurant. No external calls occur inside confirmation. Direct database administration must coordinate with this lock; application workflows always do.

## Tokens and business date

UUID is the permanent identity. `(business_date, token_number)` is unique. `RESTAURANT_TIMEZONE` defaults to Asia/Kolkata; the business date is the PostgreSQL server clock's calendar date in that timezone, resetting at local midnight (no custom shift cutoff). Capture time/date together after validation. Atomic INSERT…ON CONFLICT increments order_daily_tokens and returns the token, in the same transaction. First committed confirmation on a new date receives 1. Failed transactions consume no committed token; committed tokens are never recycled. Cancelled-token reuse remains forbidden when cancellation is implemented. Date accompanies token lookup to avoid cross-day ambiguity. Keep restaurant server time correct and coordinate timezone changes at a business boundary.

## Idempotency

A browser-generated UUID requestId is unique per authenticated creator. SHA-256 of the ordered normalized lines binds the key to the payload. Same actor/key/same payload returns the original snapshot even after menu/tax changes; different payload returns IDEMPOTENCY_CONFLICT. Different actors have separate key scopes. Records/keys are retained with orders, without automatic expiry. Validation failures roll back and do not reserve a key. The shared transaction lock and database unique constraint prevent simultaneous duplicate creation.

Before sending, POS stores the exact request in per-user sessionStorage. While outcome is uncertain, editing/new submissions are locked and Retry sends the same request. Page reload in the same tab recovers that request. Success clears it and shows token/total; New Order explicitly starts the next draft. Ordinary unsent drafts are memory-only; closing the tab loses them. Closing a tab with an ambiguous request also loses its tab-scoped recovery data: use the order read API to check before starting a replacement. No disconnected-browser queue is implemented.

## Sale snapshots, money and tax

Items retain menu/variant FKs plus item name, kitchen name (fallback item name), variant name, unit price, quantity, line subtotal and instruction snapshots. Reads never use current names/prices. Lines with different instructions remain separate. The UI merges added lines only when variant ID and trimmed, case-sensitive instruction match; edits do not automatically consolidate lines. The server preserves submitted line boundaries.

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

List filters are optional; omit businessDate for pending work spanning midnight. Pass nextCursor as after with the same filters for the next page. Current statuses are QUEUED only; other lifecycle values are reserved in the policy/schema. No history mutation API is exposed. Public shared contracts contain no request fingerprint or persistence credentials.

OWNER/MANAGER/CASHIER already have orders.create/read. Migration 008 additionally grants orders.read to KITCHEN for the next queue consumer, without order creation, menu administration or Kitchen UI actions. DISPATCH order reading remains deferred. Multi-role unions work normally.

## Future KDS contract

GET /api/orders?status=QUEUED returns source, order UUID, businessDate, tokenNumber, queuedAt (waiting-duration basis), confirmedBy and item UUID/menu IDs, snapshotted item/kitchen/variant names, quantities and plain kitchen instructions. Sort is queued_at ASC,id ASC with a cursor, across dates by default. Build lifecycle commands/history around Orders rather than writing tables from Kitchen. No Socket.IO/event delivery, prioritization, kitchen aggregation or KDS UI exists yet.

## Verification

Unit tests cover exact paise/tax rounding, config validation, lifecycle policy and cart merge rules. PostgreSQL integration covers snapshots, permissions/strict input, concurrent tokens, replay/conflict, availability locking, immutable records, reads and tax changes. Browser regression exercises the existing menu/media/availability UI plus cashier cart confirmation, a lost response and page reload with same-request recovery. All fixtures use isolated PostgreSQL schemas; existing operational data is not seeded or rewritten.

Completed verification on 2026-09-22: `npm run check` (8 API unit tests and 5 frontend/helper tests), all 57 PostgreSQL integration tests, and local Chromium browser regression passed. Browser checks covered Soya Chaap Full ×2 / Extra spicy, another line's quantity/removal/re-addition, consecutive tokens, double-click, another-session sold-out rejection, lost response and reload/retry returning the same token. External browser requests were blocked. This verifies local application dependencies, not a physical router-disconnection exercise. Migration 008 was applied locally with before/after equality checks for users, assignments, audits, catalog and image records plus file hashes; all were preserved.
