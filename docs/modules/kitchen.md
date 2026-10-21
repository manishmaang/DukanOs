# Kitchen

## Purpose and workflow

Kitchen combines preparation, Dine-In serving and Parcel/platform handover. There is no separate operational Dispatch screen. Pending rounds are QUEUED plus legacy PREPARING/READY, ordered by queued_at then UUID. No Start or Mark Ready button is required. FIFO guides visibility, not a restriction on serving food that is ready. Old lifecycle/history records remain valid and readable.

Order cards show authoritative DINE IN / PARCEL plus the Bill reference, or the platform source and external reference. Unknown legacy service is explicitly labeled. Dine-In lines show ordered, served and pending quantities. Served lines remain readable with muted styling and SERVED until the whole round completes. Quantity controls serve a whole remaining line or a smaller quantity. Corrections require a reason, append a negative event, and are allowed only while the round is nonterminal. Completing the last required quantity completes the round, not its Bill; unpaid Dine-In remains supported.

Parcel/platform/unknown legacy rounds use Ready & Handed Over. Parcel requires both amount_due and refund_due zero. Platforms have no DukanOS financial participation. A single real transition goes from the current active state to COMPLETED; no artificial PREPARING/READY history is inserted.

## Persistence and concurrency

Migration 022 adds append-only order_serving_events and kitchen_fulfillments. Events link to the stable original order/line identity and current effective amendment revision, actor, timestamp, signed quantity, expected prior served quantity, correction reason and request identity/hash. PostgreSQL locks serialize restaurant mutations; sum quantities must remain between zero and the effective line quantity. Backend rechecks the live session/capability inside the transaction. Stale revision/quantity returns 409. Replaying an actor/request with identical intent returns the previous result; changed intent returns IDEMPOTENCY_CONFLICT.

Any serving history blocks manual amendments, even after correction to zero. Completed rounds cannot be corrected/reopened. Add replacement food as a new round. No payment/refund or financial snapshot mutation accompanies serving.

At configured previous-day cleanup (default 05:00), a Dine-In round with a positive net served quantity completes in full. The owner explicitly chose this rule. Append a system kitchen_fulfillments record and NULL-actor history reason PREVIOUS_BUSINESS_DAY_PART_SERVED_COMPLETE; retain actual serving evidence without pretending remaining food was served. Preserve the full effective sale value and payments. Active linked timers are resolved as cancelled with that system reason. Existing midnight Bill rollover remains independent: this action does not pay or close Bills. Fully unserved rounds retain the existing cancellation policy; corrected-to-zero history may be system-cancelled, but never manually amended.

## Production

Production uses remaining quantities, retaining the existing item/variant/snapshot/source/preparation grouping keys. Its primary title is uppercase human-readable variant + item name. Totals and instruction breakdowns remain prominent; all-normal groups omit the redundant Normal row. Each group also shows source token, DINE IN/PARCEL/reference or platform label and remaining quantity. A mixed-service aggregate is never assigned a single service label. Served quantities and completed rounds disappear from pending production.

## APIs and permissions

All routes are under /api, authenticated and no-store. Mutations require X-DukanOS-Request: 1 and strict JSON DTOs; UUIDv4 parameters, unexpected fields and query fields are validated/rejected.

- GET /kitchen/orders: kitchen.read; KitchenState adds pending[] and production.pending[], serviceType/reference/revision and per-line servedQuantity/pendingQuantity. Legacy queued/preparing projections remain available.
- GET /kitchen/production: kitchen.read; pending groups plus legacy grouped projections.
- POST /kitchen/orders/:id/lines/:line/serve: kitchen.fulfill; requestId, expectedRevision, expectedServedQuantity, signed nonzero quantity (-99..99), optional reason (required for correction, max 500). Returns orderId, lineId, servedQuantity.
- POST /kitchen/orders/:id/fulfill: kitchen.fulfill; requestId, expectedRevision; returns orderId and COMPLETED.
- Existing START/READY and Dispatch endpoints remain compatibility commands; normal UI never calls them. A legacy READY Dine-In handover without serving history remains compatible. Once serving events exist, remaining items must be served before completion.

Migration 022 grants kitchen.fulfill to OWNER/MANAGER/KITCHEN/DISPATCH and kitchen.read to DISPATCH. It grants no money, menu administration, availability or timer rights to DISPATCH. Existing operational role unions and privileged exclusivity remain unchanged.

## Freshness, responsive behavior and limits

Visible-page polling remains every two seconds, refreshed on actions/focus/reconnect, with server-clock-based age and static LATE badges (default 15 minutes). Failed reads remove stale actionable cards. Serving survives refresh through PostgreSQL, not browser state. Production remains read-only; serve in Order View. Long references and names wrap; controls are touch-sized. Desktop retains compact three-column order/four-column production grids and responsive reductions. No external service is required when API/PostgreSQL/LAN are available.

No completed-order undo, post-serving commercial amendments, inventory inference, reprioritization or disconnected-browser writes. Existing history plus serving events preserve audit evidence; dedicated completed-serving-history UI remains future work. Deployment and browser verification status is recorded in [the active checkpoint](../checkpoints/real-shop-workflows.md).

## Counter Availability panel

The permission-filtered Availability button beside the view controls opens a searchable native modal with whole-dish and per-portion sold-out/restore actions. It shows only active priced Counter portions, including sold-out entries. No prices, images or general menu editing controls are displayed. Escape/Close returns to the queue. Availability is not placed on token/production cards.

The panel calls the existing GET /api/menu/counter and PATCH /api/menu/counter/items/:id/availability. It passes the current item version, available boolean and optional variantId. Menu enforces capability/session, optimistic version, Counter scope, locking and actor/before/after/time audit. No separate Kitchen availability state or audit exists. Other portions and Zomato/Swiggy stay unchanged for a portion action; whole-dish changes cover eligible Counter portions only. Confirmed orders and their production quantities are unchanged.

The panel refreshes while open on five-second visible polling, focus, online/visibility return and existing menu notifications; sequence checks prevent stale reads overwriting writes. Conflicts refresh for review, without blindly retrying a mutation. Errors hide stale availability controls. Successful writes use the existing menu notification; independent POS devices refetch within their existing five-second window plus request time. Draft carts may retain a newly sold-out portion, but confirmation rejects it with ITEM_NOT_AVAILABLE. No menu administration permission is granted.

Usability coverage adds threshold/configuration boundary tests, instruction grouping without source mutation, Kitchen Counter-only permission/audit tests, and browser density, remaining Production quantities with source tokens, static reduced-motion late styles, availability search/restore and existing-cart rejection.

## Dispatch handoff

Kitchen now owns normal handover; the legacy Dispatch API remains a compatibility boundary only. See [Dispatch](dispatch.md).

The responsive audit preserves existing Order/Production grid breakpoints and quantities. Availability uses a sticky Close header, phone-sized dynamic/visual-viewport bounds and wrapped long dish/portion names; short viewports retain scrolling access. See [Responsive UI](../RESPONSIVE_UI.md) for touch, keyboard and device requirements.

## Bills boundary

Orders remain individual preparation rounds when several tokens share a Bill. Kitchen does not manage settlement or display financial data. Migration 012 removes generic orders.read from KITCHEN, preserving kitchen.read/update and operational projections. Dine-In serving and Parcel settlement gating are enforced by fulfillment commands and database guards; no financial data is exposed to Kitchen.

## Persistent operational timers (013)

Kitchen now has a secondary timer strip separate from Order/Production cards. + Timer offers 1/2/3/5-minute presets, custom minutes, a label and optional active order/item association. Server-generated absolute timestamps survive reload/new devices. Due timers remain visibly TIMER DONE / OVERDUE until acknowledged or cancelled, with actor/time and concurrency-safe resolution. Timers never change FIFO, quantities, instructions, availability, Order View transitions or production aggregation. No financial reminder data is shown in Kitchen. See [Operational alerts](alerts.md) for schema, capabilities, local countdown fallback and reconciliation.

Kitchen timer sound is opt-in through Enable Sound / Test sound in the timer strip. Three short local beeps repeat at most every 20 seconds while overdue; acknowledgement/cancellation suppress audio immediately. Multiple due timers share a single pattern. Device mute never resolves a timer. See [audible alerts](alerts.md#secondary-audible-alerts) for unlock, offline/reconnect and background limits.

## Queued revisions (014)

Kitchen/Production read effective_order_items, so a queued replacement/reduction/removal updates both modes on normal polling without duplicate original quantity. Original order/token/FIFO time remain. Serving/handover and amendment commits share the restaurant lock; serving history or terminal completion blocks later edits. Handover checks expectedRevision so an amended card cannot silently be fulfilled. Legacy START still blocks edits after it wins. Active associated timers block amendments; no timer silently changes food. Kitchen has no amendment/refund capability. See [Amendments](amendments.md).

## Previous-day cleanup boundary (019)

At/after the configured daily cleanup cutoff, earlier-date active work is system-cancelled except partly served Dine-In, which completes at full value under migration 022. Existing status-filtered authoritative reads remove it from Order/Production, FIFO/NEXT and late indicators. Attached active timers cancel atomically. START/READY rejects after cancellation; current-day work is unchanged. See Orders for timing and audit.

## Manual platform preparation (020)

The same FIFO now contains Counter, Zomato and Swiggy. Every Order card shows a text source badge; platform cards include external reference and NORMAL QUANTITY or LESS QUANTITY derived from the immutable order mode for each line; legacy measured lines additionally show their original g/ml snapshots. Production additionally groups by source, mode, amount and unit, keeping Normal/Less, sources, qualitative and materially different historical measurements separate while retaining original source-line/token associations. It shows source/serving labels, pending portion counts, useful instruction breakdowns and source-token/service references. Timers, late age and polling remain; no START/READY action is required. Platform cancellation/cleanup removes active work and resolves linked timers without finances. See Platform Orders.

## Compact Order View (2026-10-21)

Order cards are content-sized and top-aligned in the existing row-major grid (three columns on wide screens, two on tablets, one below 700px). The previous default grid stretch made short cards as tall as their longest neighbor; inherited 24px form margins and growing quantity labels added further empty space. Explicit start alignment and zero serving-form margins remove that waste. Rows retain FIFO order; no masonry/reordering is used, so space below shorter cards is intentional.

Headers combine token/NEXT/NEW and waiting or LATE age with wrapping channel, service and reference information. Platform sources remain explicit, never classified as Parcel. Each stable line has a compact portion/ordered/pending/served summary beside its controls. One remaining portion uses Serve 1 without a quantity field; larger remaining quantities default to all pending in a bounded input. Editing the input never submits. Corrections retain quantity, required reason and existing server checks. Fully served lines stay muted/readable with correction access while the round remains active.

Exact plain-text instructions remain immediately beneath their own line, highlighted and multiline without truncation. Production keeps its existing totals, keys and instruction summary; each source row additionally displays its own exact instruction and platform reference from the same Kitchen response. Backend/schema/permissions/aggregation/financial behavior are unchanged. See [compact UI checkpoint](../checkpoints/kitchen-compact-ui.md) for measurements and verification.
