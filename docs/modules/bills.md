# Bills / Tabs

## Purpose and boundary

A Bill is one commercial tab. An Order is one Kitchen preparation round with its own permanent ID, daily token, snapshots and QUEUED → PREPARING → READY → COMPLETED lifecycle. Adding items to an open bill creates a new order/token; completed rounds are never reopened. Payments attach to bills, never individual tokens. Anonymous customers are supported; no customer, reservation or full table-management module is introduced.

## Model and lifecycle

Migration 012 adds bills, bill_daily_numbers, payments and the bill_balances view; every order has a restrictive bill_id FK. New bills require DINE_IN or TAKEAWAY and may carry a plain-text reference up to 80 characters. UUID identifies a bill; (business_date,bill_number) is unique and separate from Kitchen tokens. Numbers use an atomic daily UPSERT with the order's configured restaurant date/time, inside first-order confirmation. A failed confirmation creates neither an empty bill nor a token.

Bill lifecycle is OPEN → CLOSED. OPEN + PAID is valid and can receive further rounds. Closing is explicit for both service types and requires zero amount_due, zero refund_due and all child orders COMPLETED. Close records actor/time, is safe to repeat, and prevents additional orders/collections. No reopen/delete/edit endpoint exists. Dine In serving is allowed while unpaid; Takeaway READY → COMPLETED requires the entire current bill balance to be paid, enforced in Orders and a database trigger. This milestone gates every Takeaway round's handover, not just a UI-defined final round.

## Financial projection

bill_total = sum of confirmed child-order grand_total snapshots. No current Menu lookup, second bill tax calculation or rupee rounding. total_collected and total_refunded come from the append-only ledger; net_paid = collected - refunded; amount_due = max(total - net_paid,0); refund_due = max(net_paid - total,0). All amounts are exact PostgreSQL numeric and JSON decimal strings. Backend projections are authoritative; browser amounts only describe entered receipts.

Status is derived: positive refund_due → REFUND_DUE; zero balance → PAID (including free/zero-total orders without fake payments); no net payment with positive total → UNPAID; otherwise PARTIALLY_PAID. Refund posting is not enabled yet.

## APIs and capabilities

All paths have /api prefix, existing session/mutation-header checks and strict DTO/unknown-field validation.

- POST /orders/counter: existing requestId/lines plus either serviceType and optional reference for a new bill, or billId alone for an existing open bill. First bill and first order commit atomically. Idempotency fingerprint includes bill selection/service/reference and normalized lines. Old committed pre-Bills confirmations may replay their original payload/fingerprint after backfill; new requests must specify bill context.
- GET /bills?search=...&after=UUID: OPEN bills, oldest opened_at/id first, up to 100, nextCursor. Search matches reference text or exact bill number. Requires bills.read + payments.read. Each page is one repeatable-read snapshot.
- GET /bills/:id: summary, child tokens/status/totals and compact payment history with actor/time. Same read capabilities. Closed bills remain retrievable by ID.
- POST /bills/:id/payments: collection; see Payments.
- POST /bills/:id/close: no body/query, bills.manage. Returns current detail; repeated close returns the same closed bill without changing closure identity.

OWNER/MANAGER/CASHIER receive bills.read/manage and payments.read/collect. KITCHEN has dedicated operational projections only; migration 012 removes its old generic orders.read grant because those responses include prices/totals. DISPATCH receives only service type, bill ID, due and derived status through its own projection. Role unions remain unchanged.

## Transactions and concurrency

Reuse restaurant write lock 742019323, then actor/session checks and bill row locking. All application order confirmation, collection, close and handover operations serialize at that boundary. Two devices cannot both collect the same remaining balance. Close racing an added round either closes first and rejects the round or observes the new active round and fails. Payment retries check actor-scoped request identity before closed/current-due checks. Database triggers independently guard open-bill insertion, valid closure, immutable ledger and Takeaway settlement. Direct maintenance must follow the same lock order; no external network call occurs in these transactions.

## Legacy migration

Each pre-012 order gets one explicitly legacy OPEN bill, with its original timestamp/actor, a separate date-scoped bill number, null service_type and no fabricated payment. The migration only adds the bill relationship to orders; existing snapshot/lifecycle/history data is preserved. Legacy bills do not acquire a guessed Takeaway payment gate. Their UI labels service unknown and explains that ledger due is not evidence of an unpaid historical sale. No automatic settlement or closure is inferred. Legacy balances need operator review before collecting any money; historical payment reconciliation is not implemented.

## Frontend and responsive behavior

POS adds Open Bills and a labelled Service selector/reference in Current Order. Default visible selection is Dine In; Takeaway is an explicit alternative. Open Bill → Add Items uses the existing cart/menu, with selected bill clearly identified. Discarding a different unsent draft requires confirmation. Success offers View Bill / Payment. Bill detail shows totals, rounds, ledger, collection form and explicit Close Bill. A paid bill remains open until staff closes it after all rounds complete.

Natural document scrolling, wrapping cards, 44px controls and decimal input keep settlement usable on phones/portrait tablets; landscape/desktop retain existing POS layout. No modal financial table or duplicated mobile DOM. Details can recover from /#/pos?bill=UUID. Pending collection is stored per user/bill in sessionStorage before sending; reload restores the exact request for retry. Closing the browser tab loses that recovery data: inspect ledger history before a replacement collection. The server remains authoritative when another device changes due.

## Next milestone boundary

Future amendments must append auditable order revisions/adjustments and change effective bill totals without rewriting past collections. A higher total produces amount_due; a lower total produces refund_due. Future legitimate refunds are CASH ONLY at Counter, even for original UPI collections. Payments schema reserves REFUND and enforces cash-only method, but a trigger rejects every refund insert until the authorized amendment/refund workflow arrives. No refund/amendment UI or endpoint is implemented.

## Verification (2026-09-24)

`npm run check` and all 89 PostgreSQL integration tests passed. Coverage includes forward/backfill preservation, pre-migration replay, partial Cash/UPI collections, immutable ledger/constraints, role boundaries, overpayment races, independent numbering, close-versus-add races, and aggregation of child tax/paise snapshots. Existing Menu/POS, Kitchen, Dispatch and eight-size responsive browser regressions passed.

The Bill browser suite performed the requested Dine In scenario (Table 4: Manchurian + Noodles, served unpaid, then Soya Chaap on a new token, partial UPI + remaining Cash, explicit close) and Takeaway scenario (unpaid handover rejected, cashier/dispatch collection, handover, explicit close) at 390×844, 768×1024, 1024×768 and 1440×900. It also verified lost-payment-response/reload retry, double submission, pure Dispatch restrictions and long references at all eight required sizes, with external traffic blocked. Screenshots were reviewed, including the 390×420 payment form. This is browser-driven verification; physical Android/iOS keyboard, native picker and assistive-technology smoke testing remains outstanding.

Local migration preservation was verified across 18 existing tables (orders compared excluding the added bill_id; intentional permission additions/removal checked separately). Four preexisting local orders became four legacy bills with zero fabricated payments. The local application restarted successfully and passed database readiness/protected-route checks. This records a development verification, not a production backup or historical-payment reconciliation.

## Confirmation collection, food details and reminders (013)

Bill detail rounds now include ordered item/variant snapshot names, quantity and optional instruction, in original line order. UI emphasizes Round 1/2 and food; token/date/status remains secondary and each round retains its immutable total. Menu renaming/repricing does not change this display.

POS supports collecting full Cash/UPI or partial/split tender during atomic order confirmation, including existing unpaid bill balance. See Orders/Payments for quote and retry semantics. Unpaid open Dine In details expose persistent payment reminder presets/custom interval; one schedule belongs to the whole bill, across every round. Paid bills pause reminders; new due on an open bill resumes the saved preference. See [Operational alerts](alerts.md) for recurrence, snooze, multi-device polling and offline fallback.
