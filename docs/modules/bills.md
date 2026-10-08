# Bills / Tabs

## Purpose and boundary

A Bill is one commercial tab. An Order is one Kitchen preparation round with its own permanent ID, daily token, snapshots and QUEUED → PREPARING → READY → COMPLETED lifecycle. Adding items to an open bill on the current restaurant business date creates a new order/token; completed rounds are never reopened. Payments attach to bills, never individual tokens. Anonymous customers are supported; no customer, reservation or full table-management module is introduced.

## Model and lifecycle

Migration 012 adds bills, bill_daily_numbers, payments and the bill_balances view; every order has a restrictive bill_id FK. New bills require DINE_IN or TAKEAWAY and may carry a plain-text reference up to 80 characters. UUID identifies a bill; (business_date,bill_number) is unique and separate from Kitchen tokens. Numbers use an atomic daily UPSERT with the order's configured restaurant date/time, inside first-order confirmation. A failed confirmation creates neither an empty bill nor a token.

Bill lifecycle is OPEN → CLOSED. OPEN + PAID is valid and can receive further rounds only on its business date. CLOSED means the ordering/tab session has ended; it does not guarantee financial settlement. Manual close requires zero amount_due, zero refund_due and all child orders COMPLETED or CANCELLED. System business-day rollover closes older OPEN sessions regardless of balances or active rounds. Closure records reason/time and a human actor only for MANUAL, is safe to repeat, and prevents additional food. Rollover-closed bills can still receive legitimate collections and cash refunds. No reopen/delete/edit endpoint exists. Dine In serving is allowed while unpaid; Takeaway READY → COMPLETED requires the entire current bill balance to be paid, enforced in Orders and a database trigger. This milestone gates every Takeaway round's handover, not just a UI-defined final round.

## Financial projection

bill_total = sum of effective child-order grand totals. No current Menu lookup, second bill tax calculation or rupee rounding. total_collected and total_refunded come from the append-only ledger; net_paid = collected - refunded; amount_due = max(total - net_paid,0); refund_due = max(net_paid - total,0). All amounts are exact PostgreSQL numeric and JSON decimal strings. Backend projections are authoritative; browser amounts only describe entered receipts.

Status is derived: positive refund_due → REFUND_DUE; zero balance → PAID (including free/zero-total orders without fake payments); no net payment with positive total → UNPAID; otherwise PARTIALLY_PAID. Cash refund posting is implemented and limited to current refund_due.

## APIs and capabilities

All paths have /api prefix, existing session/mutation-header checks and strict DTO/unknown-field validation.

- POST /orders/counter: existing requestId/lines plus either serviceType and optional reference for a new bill, or billId alone for an existing open bill. First bill and first order commit atomically. Idempotency fingerprint includes bill selection/service/reference and normalized lines. Old committed pre-Bills confirmations may replay their original payload/fingerprint after backfill; new requests must specify bill context.
- GET /bills?search=...&fromBusinessDate=YYYY-MM-DD&toBusinessDate=YYYY-MM-DD&after=UUID: OPEN and CLOSED bills, up to 100 with nextCursor. Default Bills scope = current business date. Explicit search without date range = global historical search. Explicit date range = inclusive range scope; search plus range searches within that range. Numeric `1`, `#1` and `0001` match exact Bill number only; other text matches literal case-insensitive reference substrings. Kitchen tokens are never searched here. Sort by business_date, opened_at and UUID, all descending. Requires bills.read + payments.read; each page is one repeatable-read snapshot. Response includes currentBusinessDate, scope TODAY/RANGE/HISTORY and effective fromBusinessDate/toBusinessDate (null for global search). Retain identical filters when passing nextCursor as after.
- GET /bills/:id: summary, child tokens/status/totals and compact payment history with actor/time. Same read capabilities. Closed bills remain retrievable by ID and through scoped listing/search. Summary/detail includes server-derived currentBusinessDate, canChangeFood and closureReason (null, MANUAL or BUSINESS_DAY_ROLLOVER), alongside closedAt.
- POST /bills/:id/payments: collection; see Payments.
- POST /bills/:id/close: no body/query, bills.manage. Returns current detail; repeated close returns the same closed bill without changing closure identity.

OWNER/MANAGER/CASHIER receive bills.read/manage and payments.read/collect. KITCHEN has dedicated operational projections only; migration 012 removes its old generic orders.read grant because those responses include prices/totals. DISPATCH receives only service type, bill ID, due and derived status through its own projection. Role unions remain unchanged.

## Transactions and concurrency

Reuse restaurant write lock 742019323, then actor/session checks and bill row locking. All application order confirmation, collection, close and handover operations serialize at that boundary. Two devices cannot both collect the same remaining balance. Close racing an added round either closes first and rejects the round or observes the new active round and fails. Payment retries check actor-scoped request identity before closed/current-due checks. Database triggers independently guard open-bill insertion, valid closure, immutable ledger and Takeaway settlement. Direct maintenance must follow the same lock order; no external network call occurs in these transactions.

## Legacy migration

Each pre-012 order gets one explicitly legacy OPEN bill, with its original timestamp/actor, a separate date-scoped bill number, null service_type and no fabricated payment. The migration only adds the bill relationship to orders; existing snapshot/lifecycle/history data is preserved. Legacy bills do not acquire a guessed Takeaway payment gate. Their UI labels service unknown and explains that ledger due is not evidence of an unpaid historical sale. No settlement is inferred. Migration 016 also closes historical legacy sessions, while retaining the unknown-receipts warning. Legacy balances need operator review before collecting any money; historical payment reconciliation is not implemented.

## Frontend and responsive behavior

POS adds Open Bills and a labelled Service selector/reference in Current Order. Default visible selection is Dine In; Takeaway is an explicit alternative. Current-day Open Bill → Add Items uses the existing cart/menu, with selected bill clearly identified. Discarding a different unsent draft requires confirmation. Success offers View Bill / Payment. Bill detail shows totals, rounds, ledger, collection form and explicit Close Bill. A paid bill stays open during its business date until staff closes it after all rounds complete; rollover ends remaining older sessions.

Natural document scrolling, wrapping cards, 44px controls and decimal input keep settlement usable on phones/portrait tablets; landscape/desktop retain existing POS layout. No modal financial table or duplicated mobile DOM. Details can recover from /#/pos?bill=UUID. Pending collection is stored per user/bill in sessionStorage before sending; reload restores the exact request for retry. Closing the browser tab loses that recovery data: inspect ledger history before a replacement collection. The server remains authoritative when another device changes due.

## Amendment and refund boundary

Queued amendments append immutable revisions and change effective totals without rewriting collections. Higher totals produce amount_due; overpayment produces refund_due, not an automatic refund. POST /bills/:id/refunds records actual CASH returned, including partial refunds, with payments.refund capability and actor-key idempotency. Both due amounts must be zero for manual closure/Takeaway handover; rollover is a session-only exception. Cancelled rounds are terminal for closure. See [Amendments](amendments.md).

## Verification (2026-09-24)

`npm run check` and all 89 PostgreSQL integration tests passed. Coverage includes forward/backfill preservation, pre-migration replay, partial Cash/UPI collections, immutable ledger/constraints, role boundaries, overpayment races, independent numbering, close-versus-add races, and aggregation of child tax/paise snapshots. Existing Menu/POS, Kitchen, Dispatch and eight-size responsive browser regressions passed.

The Bill browser suite performed the requested Dine In scenario (Table 4: Manchurian + Noodles, served unpaid, then Soya Chaap on a new token, partial UPI + remaining Cash, explicit close) and Takeaway scenario (unpaid handover rejected, cashier/dispatch collection, handover, explicit close) at 390×844, 768×1024, 1024×768 and 1440×900. It also verified lost-payment-response/reload retry, double submission, pure Dispatch restrictions and long references at all eight required sizes, with external traffic blocked. Screenshots were reviewed, including the 390×420 payment form. This is browser-driven verification; physical Android/iOS keyboard, native picker and assistive-technology smoke testing remains outstanding.

Local migration preservation was verified across 18 existing tables (orders compared excluding the added bill_id; intentional permission additions/removal checked separately). Four preexisting local orders became four legacy bills with zero fabricated payments. The local application restarted successfully and passed database readiness/protected-route checks. This records a development verification, not a production backup or historical-payment reconciliation.

## Confirmation collection, food details and reminders (013)

Bill detail rounds now include ordered item/variant snapshot names, quantity and optional instruction, in original line order. UI emphasizes Round 1/2 and food; token/date/status remains secondary and each round shows its effective total with immutable original/revision history. Menu renaming/repricing does not change this display.

POS supports collecting full Cash/UPI or partial/split tender during atomic order confirmation, including existing unpaid bill balance. See Orders/Payments for quote and retry semantics. Unpaid open Dine In details expose persistent payment reminder presets/custom interval; one schedule belongs to the whole bill, across every round. Paid bills pause reminders; new due on an open bill resumes the saved preference. See [Operational alerts](alerts.md) for recurrence, snooze, multi-device polling and offline fallback.

POS payment reminders have optional local two-note sound, coalesced at most every 60 seconds while overdue. Enable Sound / Test sound and mute are device preferences, independent of the persisted reminder interval and financial state. Snooze suppresses the current occurrence immediately; successful full settlement and canonical reconciliation remove eligibility. See [audible alerts](alerts.md#secondary-audible-alerts) for activation, fallback and browser limits.

## Business-date protection and history scope (2026-09-30)

Historical Bills cannot receive new Kitchen rounds. Food confirmation/quote and amendment quote/commit (including cancellation/instruction-only edits) require OPEN plus bill.business_date equal to the current configured restaurant business date. Different-date requests return BILL_NOT_CURRENT_BUSINESS_DATE (409); closed bills continue to return BILL_CLOSED. Both past and future mismatches are ineligible. Already committed idempotent requests replay before this guard and never create another food change.

Orders and Bills share RestaurantClock: PostgreSQL clock_timestamp() converted with configured RESTAURANT_TIMEZONE, default Asia/Kolkata. No browser date, database session timezone or UTC-day assumption. Business midnight remains calendar midnight, not a shift cutoff. New-order confirmation captures one instant/date for its eligibility check, queued timestamp and token allocation after acquiring the restaurant lock and resolving prices. Amendments check date under the same lock before quoting/committing; a pre-midnight quote cannot authorize a new post-midnight change. Date eligibility is enforced in domain code; existing database open-bill/immutability guards remain intact.

Bills opens Today with no filters. Search without dates spans history; clearing search immediately restores Today unless dates are applied. Both From/To are required and validated as real YYYY-MM-DD dates with From <= To. Apply dates keeps search; Clear dates keeps search; Today clears both. Scope is labelled from the API result, and dates accompany every result. Contextual empty states distinguish Today, date range and search. Historical details show a small notice and retain food, tokens, history and financial actions while hiding Add Items/amendment controls. Three-second polling refreshes server eligibility across midnight; the API remains authoritative between polls. Pending successful amendment replay stays available across date changes.

Migration 016 supersedes the original no-auto-close behavior: older OPEN sessions close without settlement. Legitimate collection/refunds and Kitchen lifecycle continue; reminders pause for rollover. Manual closure remains strict. Migration 015 only adds listing and exact-number-search indexes; it changes no rows. Substring reference search uses parameterized strpos without wildcard interpretation; no full-text infrastructure is introduced. Cursor pages are current snapshots, not a frozen multi-request export.

Verification: npm run check and all 119 PostgreSQL integration tests passed. Expanded Bills and existing amendment/refund browser regressions passed at four workflow sizes, all eight boundary sizes and constrained height with external requests blocked. Local migration 015 preserved row counts/fingerprints across all 27 non-migration tables, including 24 bills, 27 orders, 21 payment/refund records, 2 amendments and 104 Kitchen/status history records. Only schema_migrations gained its entry; no local image file is touched by the migration. Physical-device native date picker/keyboard and assistive-technology checks remain outstanding.

## Automatic business-day rollover (016)

The HTTP server explicitly starts BillRolloverService before accepting requests: one awaited catch-up transaction, then a local check every 60 seconds. No browser, internet, external cron, queue or cloud service is required. Failed startup catch-up prevents serving; failed periodic checks log a generic error and retry next interval. Graceful shutdown clears the timer and awaits running work. Read-only application/CLI contexts do not start the worker.

Each transaction obtains restaurant advisory lock 742019323, then reads PostgreSQL time through RestaurantClock, and updates only OPEN bills with business_date strictly before that date. Midnight is the configured calendar midnight (default Asia/Kolkata), not browser time, database session timezone or a shift cutoff. Local overlapping calls coalesce; independent processes serialize. Repeated checks change no already-closed row. Failed transactions leave sessions/reminders unchanged.

System closure stores BUSINESS_DAY_ROLLOVER, closed_by NULL, actual processing closed_at and closure_timezone for checkable historical eligibility. It never backdates a restart to midnight. Existing manual closures are labelled MANUAL without rewriting actor/time. No reopen, fake System user, payment, refund, customer or balance write is introduced. Identity, dates, numbers, orders, revisions, timers and history are preserved.

Historical bills may remain CLOSED with ₹300 UNPAID or ₹50 REFUND DUE. Existing capability-checked collection/refund APIs and UI remain available for rollover closures; manually closed bills reject new ledger writes. Food changes remain forbidden. Existing rounds may START, become READY and be served; Takeaway still requires both dues zero. Active reminders pause atomically with BUSINESS_DAY_ROLLOVER and disappear on authoritative frontend polling. Reports retain bills and financial amounts; only status counts change. Customer Ledger/Khata is not implemented.

## Local migration verification (2026-10-02)

Migration 016 and actual HTTP startup closed 23 of 24 existing local Bills; the remaining bill was already manually closed. No active reminder needed pausing in this local dataset (isolated integration/browser fixtures cover that transition). Before/after fingerprints matched all 25 other source tables, all derived financial balances and all 3 menu image files. All 27 orders and 21 collection/refund records were retained byte-for-byte, along with users, menu, revisions and Kitchen/Dispatch histories. Existing Bill fields changed only for eligible closure; the previously closed Bill gained MANUAL metadata. Health returned 200 and unauthenticated Dashboard 401. A later periodic check remained idempotent.

## Previous-day cleanup boundary (019)

Rollover still closes historical sessions at midnight. At/after the configured cleanup time, the same transaction additionally cancels earlier-date unfinished rounds through Orders revisions, even on rollover-closed tabs. Completed rounds and receipts remain. Bill balances may become zero due or refund due; the tab never reopens. See Orders for the exact daily gate.
