# Confirmed order amendments and cash refunds

## Purpose and rules

Correct a confirmed **QUEUED Counter round on an OPEN, current-business-date Bill** without replacing its order ID, token, business date, Bill or FIFO timestamp. Replacement dish/portion, reduced quantity, removed line and instruction changes are supported. Additional food/quantity always uses **Add Items → new Kitchen round/token → same open Bill**. PREPARING, READY, COMPLETED and CANCELLED rounds cannot be directly changed. Post-preparation commercial corrections and waste/inventory handling remain unimplemented.

Explicit CANCEL produces a zero-valued revision plus append-only QUEUED → CANCELLED status history. It requires a reason and never recycles the token. Removing the final line must use this cancellation operation; there is no delete or generic PATCH. Closed bills reject new amendments/refunds. Cancelled rounds count as terminal for Bill closure, alongside completed rounds.

## Persistent model and effective state

Migration 014 adds `order_amendments` (header, complete revision totals, actor/time/reason/note, actor-scoped request ID/hash) and `order_item_revisions` (complete current line snapshot for each retained logical line). Original `orders` monetary/tax snapshots and `order_items` stay immutable. Revision 0 is the original confirmation; committed revisions increase by one. Original logical line IDs remain stable, including for replacements, and cannot be reintroduced after removal. Retained quantities cannot exceed the preceding revision.

`effective_orders` selects original or latest revision totals. `effective_order_items` selects original or latest revision lines, never both. Cancel revisions have zero totals and no effective items. Bills, generic current-order reads, Kitchen/Production, Dispatch and active timer associations use these projections. Reports V1 consumes effective items with its documented Bill-cohort/date policy, not raw original order_items. Refund ledger entries never reduce effective Sales a second time.

Revision headers and lines reject updates/deletes. Late line inserts into already committed revisions fail. Deferred constraints require a complete nonempty CHANGE aggregate whose line sum matches its subtotal; CANCEL must have zero items/total and corresponding cancellation history. Per-order revision uniqueness, actor/key uniqueness, restrictive FKs, bounded exact numerics and variant/item ownership checks protect integrity. No existing sale, receipt, timer or reminder is fabricated or backfilled.

History is reconstructible from revision 0 plus successive full snapshots. GET amendments exposes before/after items, old/new round totals, reason/note and actor/time; it never exposes request hashes. Generic GET order returns the effective snapshot and revision. Retrying original Counter confirmation retains the original confirmation financial/item snapshot (with current lifecycle state), so old confirmation receipts do not silently change.

## Pricing and tax

Unchanged items, reductions and removals use the preceding immutable unit-price/name snapshots even when the Menu is repriced or unavailable. A different variant uses its current sellable Counter price and current human-readable item/kitchen/variant names when committed. Backend ignores no authoritative price fields: such fields are rejected by strict DTOs. Replacement must pass active category/item/variant/channel, price and Counter availability checks.

The round retains its original exclusive tax label/rate/mode/rounding configuration. Each revision recalculates tax once on its revised subtotal using HALF_UP to paise, and stores the result. This avoids mixing tax-policy eras within one preparation round. Future tax configuration changes never reprice old/revised snapshots. Discount and cash-rounding remain zero. Money uses BigInt paise and checked PostgreSQL numeric; JSON amounts are decimal strings.

## Transactions, quotes and races

Quote and commit use the existing restaurant advisory lock 742019323, live actor/session/capability recheck, order lock and open Bill lock. Menu writes, Kitchen START, confirmation, collections, refunds, cancellation and closure use the same serialization boundary. No external service runs in these transactions.

The request includes expectedRevision. Quote returns before/after round totals and items, Bill total before/after, net paid and resulting amount_due/refund_due. Its SHA-256 quoteHash binds normalized intent and the server-calculated preview. Commit recomputes everything and rejects changed revision, state, replacement price/availability or Bill financial result. A changed preview is never silently accepted. No quote record, token or financial transaction is created during preview.

If Kitchen START wins, amendment fails ORDER_NOT_AMENDABLE with no partial write. If amendment wins, START consumes the revised effective contents without changing FIFO. Two different edits of one revision cannot both commit. Same actor/request and identical canonical payload/hash replays the original amendment identity; a changed payload conflicts. A successful replay remains valid after later lifecycle/revision changes. Failed transactions reserve no key.

Any ACTIVE timer associated with the round (including order-only timers) blocks its amendment/cancellation with ORDER_HAS_ACTIVE_TIMER. Resolve the timer explicitly first; no timer is silently reassigned. New item-associated timers must target an effective item. Kitchen polling updates both views from one consistent snapshot; production sources retain stable order/line identity and show only current quantities/instructions.

## Financial reconciliation and refunds

Bill total sums effective child totals. Collections/refunds remain immutable:

- net_paid = total_collected − total_refunded
- amount_due = max(bill_total − net_paid, 0)
- refund_due = max(net_paid − bill_total, 0)

A cheaper partially paid Bill may still owe money; no refund is invented. Positive refund_due displays REFUND_DUE until cash is actually returned and recorded. An additional round offsets existing overpayment before quoting any new collection. Existing Cash/UPI collection handles additional due.

POST Bill refunds appends REFUND/CASH to the existing payments ledger. Amount must be positive, exact to at most two decimals and <= locked current refund_due. Partial cash refunds are supported. The API has no method selector/field; the database also prohibits REFUND/UPI and refund confirmation-order provenance. No arbitrary refund is possible with zero entitlement. Refund actor/time and request identity remain permanent. Refunds use the existing actor-scoped ledger key namespace with a type-bound hash, preventing collection/refund key confusion and duplicate cash returns.

Manual Bill closure requires both due values zero and all rounds COMPLETED/CANCELLED. Business-day rollover closes historical sessions independently of settlement without changing effective food or ledger. Takeaway handover requires both values zero in backend and database; Dispatch displays REFUND ₹… AT COUNTER when appropriate. Dine In may serve with either collection due or refund due. Dispatch/Kitchen never record refunds.

Revision insertion synchronizes the saved Dine In reminder preference: positive due resumes a paused schedule; refund/zero due pauses it. No recurring refund alarm is added. Existing visual/audio projections remove paused reminders on reconciliation; canonical Bill reads also suppress paid/refund-due collection audio.

## APIs and permissions

All routes use /api, UUIDv4, strict JSON/no unknown fields, existing session/mutation header and permission unions.

- POST /orders/:id/amendments/quote: requestId, expectedRevision, kind CHANGE|CANCEL, predefined reason, optional plain note <=500, complete desired lines (existing id, variantId, integer quantity 1–99, plain instruction <=500). At most 100 unique lines; no additions/increases. CANCEL requires empty lines.
- POST /orders/:id/amendments: same plus 64-character lowercase quoteHash. Returns amendment id, orderId, revision.
- GET /orders/:id/amendments: ordered audit history; requires orders.read, bills.read and payments.read.
- POST /bills/:id/refunds: requestId and amount string only; returns current Bill detail.

OWNER/MANAGER/CASHIER have orders.amend and payments.refund; cancellation additionally requires orders.cancel, granted to those roles. Quote/commit also require bills.read and payments.read. Refund requires payments.refund and bills.read. Pure KITCHEN/DISPATCH cannot amend/refund; multi-role staff inherit the union. No privilege-name shortcut bypasses capabilities.

## Frontend and recovery

Bill round → Change queued round opens a native focus-managed dialog: reduce quantity, edit instruction, remove, replace through photo cards/portions/search, or explicitly cancel. Choose a reason and optional note, Review Change, then Confirm Change. Server preview shows old/new amounts and additional due or CASH REFUND DUE. A collapsed Changes section shows actor/time/reason and before/after foods. Preparation-started rounds explain why changing is unavailable.

Refund form has Cash returned and Confirm Cash Refund, never a method selector. Ledger labels Collected and Cash Refunded explicitly. Both amendment and refund requests are saved to per-user tab storage before submission; uncertain outcomes lock the request for exact retry across reload. Do not exchange money again during a retry. Closing the tab loses its recovery cache; inspect permanent history before initiating a replacement action. There is no offline write queue.

Phone dialogs use viewport-bounded scrolling, wrapping content and 44px controls; replacement cards adapt to two columns. Tablet/desktop reuse the same DOM. Existing POS/Kitchen grids and lifecycle controls are preserved. Browser emulation does not certify physical mobile keyboard, screen-reader or speaker behavior.

## Verification commands and remaining scope

Run npm run check, npm run test:integration and npm run test:amendments-browser with CHROME_BINARY. AMEND_BROWSER_WIDTH=390|768|1024|1440 runs one touch workflow plus all eight boundary layouts; run all four values for full coverage. Tests use disposable PostgreSQL schemas and blocked external requests.

No post-preparation corrections, arbitrary discounts, payment voids, UPI refunds, Customers/Credit/integrations/inventory or new infrastructure. Production tax settings and physical-device smoke testing remain operator responsibilities. Local schema migration must be applied before the new build runs; preserve normal database/media backups.

## Local migration verification — 2026-09-30

Migration 014 was applied with the normal migration runner. Before/after row counts and SHA-256 fingerprints matched for all 23 pre-existing operational tables; only migration and RBAC metadata gained the intended entries. Existing 23 orders, 21 bills, 14 payments, 92 status records, users, menu/image metadata, audits, reminders and timers were preserved. Both new revision tables started empty. The migration does not access or alter local image files. The updated local API passed its readiness check.

## Business-date cutoff (2026-09-30)

New amendment quotes/commits, including cancellation and instruction-only changes, require the parent Bill to belong to the current restaurant business date. BILL_NOT_CURRENT_BUSINESS_DATE rejects stale-day food changes even if the round is still QUEUED. The date is read from the shared PostgreSQL restaurant clock after locking; a quote spanning midnight is revalidated at commit. Successful same-request replay remains safe after midnight. Historical audit reads and legitimate collection/refund/closure are not blocked by this food-only rule. Frontend hides new food controls using backend canChangeFood while preserving pending-request recovery.

Migration 016 closes historical OPEN sessions with BUSINESS_DAY_ROLLOVER, without authorizing amendments/cancellation or modifying food. Current-day OPEN plus QUEUED and all quote/revision checks remain required. Legitimate financial reconciliation on rollover-closed tabs is separate from food changes.

## Previous-day cleanup boundary (019)

Migration 019 adds a narrow system-only cancellation revision for historical QUEUED/PREPARING/READY rounds after cleanup time, including rollover-closed Bills. Staff cancellation rules remain QUEUED/current-day OPEN only. System events retain null actor, stable reason and cutoff/timezone snapshots; history uses System as the display name. No manual API accepts the system reason.
