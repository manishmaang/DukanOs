# Kitchen Display System

## Purpose and current implementation

Kitchen has an Order View and a read-only Production View at `/#/kitchen`. It consumes immutable sale-time order lines, enforces FIFO acceptance and performs QUEUED → PREPARING → READY through Orders-owned commands. It needs only the restaurant server, PostgreSQL and LAN, without external assets/services or menu images.

## Order View

Separate Queued and Preparing sections contain compact responsive order-card grids (three columns at ≥1180px, two at 700–1179px, one below 700px). Tokens remain prominent alongside age/NEXT/LATE indicators, kitchen-name/variant snapshots, quantities and prominent plain-text instructions. Business dates appear only for older-date orders or when active orders span multiple dates. Empty instructions render nothing. Same-dish lines are visually grouped; each portion/customization retains its own line. Kitchen display names fall back to item names at confirmation, not at read time.

Both lists sort queued_at ASC, order UUID ASC, across all business dates. The oldest QUEUED order is marked NEXT; only its Start Order is enabled. Starting moves the whole order to Preparing and enables the next token, permitting parallel cooking after FIFO acceptance. Mark Ready removes an order from active Kitchen. READY orders enter Dispatch for handover; there is no arbitrary status editor.

Waiting time measures elapsed time since queued_at. Preparing time measures elapsed time since the PREPARING history entry. The browser samples serverTime and advances a monotonic local timer; it does not fetch every second just for the display. New queued arrivals receive an eight-second NEW highlight; initial page loading is not treated as a new arrival. No sound is required. Order actions are at least 48px high; reduced margins and padding increase density without reducing instructions to secondary text.

## Production View

The backend derives both views from one repeatable-read snapshot. TO START includes only QUEUED lines; IN PREPARATION includes only PREPARING lines. A transition moves **all** lines of an order between sections. READY/COMPLETED/CANCELLED never contribute. Production has no state-changing buttons; use Order View.

Aggregate key: menu item UUID + variant UUID + snapshotted item name + snapshotted kitchen name + snapshotted variant name. IDs prevent distinct products with identical labels from collapsing; snapshots keep renamed versions separate. Prices are neither selected nor exposed. Traverse FIFO-ordered orders and position-ordered lines, retaining first-seen group order: earliest source is the primary urgency, order UUID and line position resolve ties. No current Menu lookup is involved.

Each group has totalQuantity, earliestQueuedAt and sources containing orderId, lineId, businessDate, tokenNumber, quantity, instruction and queuedAt. Every original line remains a source, even when two lines share the same token/portion. The API retains every original source/token association. The chef-facing Production UI displays no source token numbers or dates. It groups source quantities by instruction after trimming and collapsing whitespace; case and punctuation remain significant, so different wording never silently merges. Original source instructions are unchanged. A Normal row appears only when blank instructions coexist with exceptions; all-normal groups need only the total. Matching exceptions share a quantity row.

To start and In preparation occupy full-width sections with compact production grids: four columns at ≥1400px, three at 1000–1399px, two at 600–999px, one below 600px. Counts mean dish/portion groups. Empty sections reduce to a heading/count, without an empty half-screen panel. The primary Production title is uppercase `{variantName} {itemName}` from immutable human-readable snapshots (for example HALF MANCHURIAN), with the prominent total beside it. Long titles wrap in their own grid column without colliding with the quantity. Order View retains its existing kitchen-name/portion presentation.

## APIs and permissions

All routes use `/api`, normal live session authentication, no-store responses and existing permission unions.

| Route                          | Permission     | Contract                                                                                                                            |
| ------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| GET /kitchen/orders            | kitchen.read   | KitchenState: serverTime, businessDate, lateThresholdMinutes, nextOrderId, queued[], preparing[], production {queued[],preparing[]} |
| GET /kitchen/production        | kitchen.read   | serverTime and queued[]/preparing[] production groups                                                                               |
| POST /kitchen/orders/:id/start | kitchen.update | QUEUED → PREPARING; 200 KitchenTransitionResult                                                                                     |
| POST /kitchen/orders/:id/ready | kitchen.update | PREPARING → READY; 200 KitchenTransitionResult                                                                                      |

All four routes reject query fields and request bodies, including `{}` on transitions. IDs must be UUIDv4. Mutations require X-DukanOS-Request: 1. Results expose operational snapshots only, no prices, taxes, payment information or request fingerprints. Contracts are in packages/shared-types/src/kitchen.ts.

Existing grants give OWNER/MANAGER/KITCHEN kitchen.read and kitchen.update. Migration 010 also grants KITCHEN menu.availability.manage, alongside its existing menu.read, without menu.manage. CASHIER alone cannot access Kitchen or transitions; CASHIER+KITCHEN can switch POS/Kitchen without logout. Backend permission/session checks are authoritative; no role-name checks determine actions.

## Transactions, FIFO and history

KitchenController delegates START/READY to Orders' OrderLifecycleService. Its transaction acquires advisory lock 742019323, then actor user/session locks, then the order lock. It rechecks active session and kitchen.update after waiting, validates the existing state policy and checks the oldest queued ID before START. This is the same serialization boundary as Counter confirmation and menu writes: no earlier uncommitted confirmation can appear behind an already-started token. Transactions stay local and short.

The service inserts one actor/time/reason history entry. Migration 009 independently validates FIFO/current state in a history insert trigger and atomically applies status in an AFTER trigger. A unique order/destination index prevents duplicate lifecycle entries. The order update guard allows only the two implemented transitions backed by history and rejects every other column change. Item/history updates and deletes, late item appends and order deletes remain forbidden. Preparing time is derived from history; no redundant timestamp columns or Kitchen tables are added. Existing records require no backfill/reset.

A stale duplicate START returns ORDER_ALREADY_STARTED; duplicate READY returns ORDER_ALREADY_READY; a wrong state returns INVALID_ORDER_TRANSITION; skipping the next token returns OLDER_ORDER_WAITING (409). Unknown orders return ORDER_NOT_FOUND. Failed transactions roll back both status and history. A retry after a lost success may return a conflict; refetch reveals the committed state without duplicating history. Timestamps never precede the prior order history timestamp, even if server clock correction moves backward.

## Freshness and recovery

There was no existing socket server. This MVP uses non-overlapping two-second visible-page polling of the combined authoritative read model, immediate refresh after every action (including conflicts), and refresh on focus, visibility return and browser online events. Both modes switch immediately within the same snapshot; primary production aggregation remains server-owned, while the browser derives only the instruction quantity display from preserved sources. Local elapsed-time rendering runs independently every second. Response sequencing prevents old reads overwriting a newer action result.

Healthy cross-device propagation is about two seconds plus request time, not guaranteed instantaneous delivery. Requests time out after ten seconds through the shared API helper. On read failure, clear the stale actionable queue, show connection feedback and continue recovery polling. No queued offline writes or automatic transition retries exist. Reconnection always refetches PostgreSQL-backed state; there is no event-replay assumption, event bus, Socket.IO, Redis or cloud service. See decision 012.

## Verification

PostgreSQL tests cover migration of populated Orders Core, FIFO/UUID ties/previous-day work, concurrent START and READY, strict input and RBAC, session revocation during lock waiting, status/history rollback, immutable financials and snapshots, production source totals and independent instructions. Unit coverage tests grouping identity and exception preservation.

`npm run test:kitchen-browser` (CHROME_BINARY required) uses isolated PostgreSQL fixtures and independent Chromium cookie jars. It creates the specified three orders through CASHIER POS, verifies totals 3+3, source instructions, NEXT, START/READY, stale-device conflict, connection loss/recovery, multi-role switching and tablet layout. External requests are blocked. This is local-browser verification, not a physical router-disconnection exercise.

## Current limitations and pending work

Preparation is order-level: no individual line DONE state, partial READY, batch completion, queue override or reprioritization. Production is read-only. Active queues are returned whole for one small restaurant; large-backlog pagination/load testing is future work. Two-second polling has bounded latency and no guaranteed push event delivery. Dispatch completion is implemented separately through Orders; sound, printing, payments, amendments and cancellation remain future work.

## Late order attention

`KITCHEN_LATE_THRESHOLD_MINUTES` is validated on API startup: integer 1–1440, default 15. Restart after changing it. KitchenState supplies lateThresholdMinutes and the current restaurant businessDate using the existing RESTAURANT_TIMEZONE. Late means total elapsed age since queuedAt **>= threshold**, for both QUEUED and PREPARING. At 14m59s the default is normal; at 15m00s it is late. Preparing duration never resets the age. The existing local one-second timer updates the badge without extra requests.

Late cards use a red border, light red tint and high-contrast LATE/total-age badge. There is no animation or blinking, including under reduced-motion preference. NEXT, sorting and backend FIFO permission are unchanged.

## Counter Availability panel

The permission-filtered Availability button beside the view controls opens a searchable native modal with whole-dish and per-portion sold-out/restore actions. It shows only active priced Counter portions, including sold-out entries. No prices, images or general menu editing controls are displayed. Escape/Close returns to the queue. Availability is not placed on token/production cards.

The panel calls the existing GET /api/menu/counter and PATCH /api/menu/counter/items/:id/availability. It passes the current item version, available boolean and optional variantId. Menu enforces capability/session, optimistic version, Counter scope, locking and actor/before/after/time audit. No separate Kitchen availability state or audit exists. Other portions and Zomato/Swiggy stay unchanged for a portion action; whole-dish changes cover eligible Counter portions only. Confirmed orders and their production quantities are unchanged.

The panel refreshes while open on five-second visible polling, focus, online/visibility return and existing menu notifications; sequence checks prevent stale reads overwriting writes. Conflicts refresh for review, without blindly retrying a mutation. Errors hide stale availability controls. Successful writes use the existing menu notification; independent POS devices refetch within their existing five-second window plus request time. Draft carts may retain a newly sold-out portion, but confirmation rejects it with ITEM_NOT_AVAILABLE. No menu administration permission is granted.

Usability coverage adds threshold/configuration boundary tests, instruction grouping without source mutation, Kitchen Counter-only permission/audit tests, and browser density, hidden Production tokens, static reduced-motion late styles, availability search/restore and existing-cart rejection.

## Dispatch handoff

Mark Ready leaves the active Kitchen queue and appears in Dispatch on its next two-second authoritative refresh. Dispatch exclusively requests READY→COMPLETED with dispatch.complete; kitchen.update alone cannot hand orders over. READY time comes from the existing history row. Migration 011 preserves Kitchen FIFO, production aggregation, instructions and sold-out controls. See [Dispatch](dispatch.md).

The responsive audit preserves existing Order/Production grid breakpoints and quantities. Availability uses a sticky Close header, phone-sized dynamic/visual-viewport bounds and wrapped long dish/portion names; short viewports retain scrolling access. See [Responsive UI](../RESPONSIVE_UI.md) for touch, keyboard and device requirements.
