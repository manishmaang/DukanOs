# Dispatch

## Purpose and current implementation

The Dispatch workspace (`/#/dispatch`) handles physical handover of READY orders. Kitchen owns QUEUED → PREPARING → READY; Dispatch requests READY → COMPLETED through the existing Orders lifecycle service. Completion is independent of payment: no financial state is invented, collected or required. Existing READY orders work immediately after migration 011, without reseeding.

## Queue and presentation

Only READY orders appear, across all business dates, ordered by the unique READY history timestamp ascending, then order UUID ascending. Token numbers identify orders to staff but do not determine sorting. A compact responsive grid shows three cards on wide desktops, two at 651–1100px and one at ≤650px. Each card has a prominent token, READY age, snapshot dish names with portions/quantities, optional secondary plain-text notes, and a minimum 48px Handed Over button. Dish grouping uses menu item ID plus item-name snapshot; distinct lines and instructions remain separate. Dates appear for older-day or mixed-date work to disambiguate repeated tokens. Counter source is implicit; other future source labels can be displayed without provider-specific behavior.

READY age measures time since READY, never time since confirmation. The API supplies serverTime, restaurant businessDate and lateThresholdMinutes; the browser advances a monotonic local timer. DISPATCH_LATE_THRESHOLD_MINUTES is a server environment integer 1–1440, default 5 (restart after changing). At or above the threshold, static orange/red styling and a LATE label draw attention without changing order. New arrivals after initial load show NEW and a static outline for eight seconds. No animation, alarm, financial display, Kitchen controls or internal identifiers appear.

Completed orders disappear after the authoritative action refresh; brief feedback identifies the handed-over token. Empty queues show “No orders waiting for dispatch.” No completed-history dashboard or daily count is implemented.

## APIs and permissions

All paths have the `/api` prefix, live session guards, no-store responses and normal mutation-header requirements.

| Route                              | Capability        | Result                                                                  |
| ---------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| GET /dispatch/orders               | dispatch.read     | DispatchState: serverTime, businessDate, lateThresholdMinutes, orders[] |
| POST /dispatch/orders/:id/complete | dispatch.complete | OrderTransitionResult: orderId, status COMPLETED, occurredAt            |

Orders contain orderId, businessDate, tokenNumber, source, readyAt and position-ordered items (id, menuItemId, itemName, variantName, quantity, instruction). All names/instructions are sale snapshots. No current Menu joins, prices, taxes, staff credentials or persistence models are returned. Shared contracts live in packages/shared-types/src/dispatch.ts and orders.ts.

Both endpoints reject all body/query fields; even `{}` is rejected on completion. IDs must be UUIDv4. OWNER, MANAGER and DISPATCH already have dispatch.read/dispatch.complete from migration 002; no grants change. CASHIER-only and KITCHEN-only cannot read or complete. Operational role unions permit CASHIER+DISPATCH, KITCHEN+DISPATCH and all three, with direct workspace switching and no logout. Dispatch does not gain generic orders.read or menu capabilities.

## Transaction, history and concurrency

Orders-owned OrderLifecycleService takes the existing restaurant advisory lock 742019323, share-locks the actor, rechecks the live session and target-specific capability, then locks the order. Only current READY may complete. Inserting one append-only READY→COMPLETED history record with authenticated actor, nondecreasing timestamp and “Dispatch handed order over” reason atomically drives the status update through database triggers. Sale data remains immutable.

Migration 011 extends the existing guards, retaining Kitchen FIFO and all previous invariants. Unique (order_id,to_status) protects history from duplicates. No direct completed_at column is added: the unique COMPLETED history row reliably supplies completion time and actor without duplicated metadata. A partial READY history index supports oldest-ready queue reads. No new tables or existing data rewrites occur.

Concurrent/stale duplicate completion returns 409 ORDER_ALREADY_COMPLETED; a different current status returns 409 INVALID_ORDER_TRANSITION. Unknown IDs return 404 ORDER_NOT_FOUND. Session/capability failures use existing 401/403 errors. Failed writes roll back history and status together. A lost success response may yield a conflict on a later attempt; authoritative refetch reveals the result. There is no automatic mutation retry, arbitrary status PATCH or COMPLETED→READY undo.

## Freshness and LAN behavior

Reuse Kitchen's two-second nonoverlapping visible-page polling, local one-second timer and immediate action/conflict/focus/online/visibility refetch. Request sequencing prevents older reads from replacing newer state. A failed read removes stale actionable cards and displays recovery feedback. The next successful read restores authoritative state. Kitchen READY appears within about two seconds plus request latency while visible; no guaranteed push delivery exists. Every operation uses the local server and PostgreSQL; no external service, event bus or cloud connection is required.

## Verification and limitations

PostgreSQL coverage includes populated migration preservation, preexisting READY orders, ready-time ordering/UUID ties, snapshot names/notes, strict input, all role boundaries, full lifecycle/actor history, concurrent/stale completion, rollback, immutable data and session revocation while waiting for a lock. The Chromium script creates three orders through POS, starts/readies them in Kitchen and completes them on separate Dispatch devices; it verifies conflict/refetch, reconnect/reload, role restrictions, multi-role switching, notes, responsive layout and historical READY-age late styling with external requests blocked. All automated fixtures are isolated from restaurant data.

No partial handover, undo/correction, sounds, printing, riders, payment warnings, completed-history UI, reports, refunds, amendments or external providers. Active queues are unpaginated for a single small restaurant. LAN/server/database/power must remain available; disconnected-browser writes and cloud synchronization are unsupported. Production TLS, backup/restore and large-backlog validation remain deployment work.
