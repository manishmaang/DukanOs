# Owner Dashboard and Reports V1

## Purpose and current implementation

Provide OWNER/MANAGER with reconciled restaurant sales, cash flow, effective item sales and operational summaries from existing records. Dashboard is a simplified operational overview; Reports is detailed financial/operational analysis with separate Sales, Payments, Items and Operations sections. This is a read-only module, not a second financial ledger or an accounting/tax compliance system.

## Financial definitions

| Metric                     | Exact meaning                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sales Value                | Sum of current `bill_balances.bill_total` for Bills whose immutable `business_date` is in the selected inclusive period. Includes OPEN and CLOSED bills and effective order tax. |
| Bills                      | Distinct selected Bills, including a bill reduced to zero by cancellation. A Kitchen round is not another Bill.                                                                  |
| Average Bill               | Sales Value divided by that Bill count; half-up to one paise. Zero when no Bills exist.                                                                                          |
| Cash / UPI Collections     | Actual COLLECTION ledger amounts of each method recorded during the selected restaurant-local dates, irrespective of the Bill's date.                                            |
| Total Collections          | Cash Collections + UPI Collections.                                                                                                                                              |
| Cash Refunds               | Actual REFUND ledger amounts recorded during those local dates. All existing refunds are CASH. Entitlement alone is not a recorded refund.                                       |
| Net Collected              | Total Collections − Cash Refunds. Can be negative on a refund-only day.                                                                                                          |
| Customer / Outstanding Due | Current sum of `amount_due` for non-legacy selected Bills. Not a historical closing balance or customer-credit ledger.                                                           |
| Refund Due                 | Current sum of `refund_due` on selected Bills; shown separately from customer due.                                                                                               |
| Legacy balance             | Current legacy `amount_due`, separately labelled as requiring review because historical receipts are unknown. Not asserted to be customer debt.                                  |

Money aggregates use PostgreSQL numeric and BigInt paise; public monetary fields are decimal strings. No financial calculation uses browser floating point. Sales includes effective food subtotal plus snapshotted tax, with existing zero discount/rounding semantics. Item sales below exclude order-level tax. Refunds never reduce Sales Value a second time.

Mandatory reconciliation examples:

- Original ₹170, UPI paid ₹170, amended to ₹120, CASH refunded ₹50 → Sales ₹120; Collections ₹170; Refunds ₹50; Net Collected ₹120, **not Sales ₹70**.
- Bill ₹500, Cash ₹100 + UPI ₹200 → Sales ₹500; Collections ₹300; Customer Due ₹200.
- One Dine In Bill with ₹300 and ₹200 rounds → one Bill, two Kitchen rounds, Sales ₹500.

## Dates, trend and attribution

Today is the server's PostgreSQL restaurant date using `RESTAURANT_TIMEZONE` (default Asia/Kolkata), never the browser or database-session timezone. Presets: TODAY, YESTERDAY, LAST_7_DAYS (today and previous six), THIS_MONTH (first through today), CUSTOM. Custom dates are real YYYY-MM-DD dates, inclusive, ordered and at most 366 days. There is no all-history default or Bills-search coupling.

Sales, service type, items, current balances and round statuses select Bills by `from <= business_date <= to`. Historical reports show **current effective commercial state of that cohort**, not an immutable end-of-day accounting snapshot. Collections/refunds and amendment counts instead select events by `created_at >= local midnight from` and `< local midnight after to`. Thus settling an older Bill today appears in today's cash flow; its sale stays with its Bill date. Sales and collections need not match.

Single-date trend has 24 hourly buckets, using each round's original queued timestamp and snapshotted restaurant timezone. Multi-date trend has one bucket per original round business date. Amendments restate the original confirmation bucket; no second sale at amendment time. Zero buckets are retained. Peak displays the earliest largest bucket on a tie; no unsupported comparison percentages.

For rare pre-cutoff Bills containing rounds outside their Bill's period, `outsidePeriodSales` is an explicit additional bucket with a UI explanation. Sum of ordinary buckets **plus this bucket equals Sales Value exactly in paise**. No value is silently moved to a different day. New same-business-date food rules prevent creating these cross-date Bills now.

## Effective item identity and historical behavior

Use `effective_order_items` / `effective_orders`, not raw original rows or current menu prices. A replacement reports only the replacement; a reduction reports effective quantity; a cancellation contributes no food quantity or sale value. Refund payments are independent and do not reduce item quantities.

Group by stable `(menu_item_id, variant_id)`, keeping portions separate. Labels use the latest original round confirmation's effective sale snapshot within the cohort, with deterministic order ID/position tie-breaks. Renaming a menu item does not split its identity or rewrite prior snapshots. Revenue sums each effective line's snapshotted subtotal even when that variant sold at several prices. Names are display labels, never aggregation keys.

Dashboard shows top five by quantity. Items report sorts by QUANTITY or SALES, with stable ID ties, fifty groups per page and total quantity/pre-tax sales across all matching groups. No full order or Bill history is downloaded into React.

## Service and operations

Dine In / Takeaway show Bill counts and effective Sales Value; null legacy service is explicitly Unknown / Legacy. No service or tender is guessed for imported Bills. Only real payment rows count as receipts.

Operations reports distinct Bills and service counts, Kitchen rounds, current QUEUED/PREPARING/READY/COMPLETED/CANCELLED counts, amendment event counts and reason breakdown (including cancellation revisions). Reliable history supports average original QUEUED → READY duration in whole seconds, including waiting, plus sample count. Unready rounds have no sample; completed rounds retain their READY sample. No per-item preparation estimate is invented.

## APIs and permissions

All routes require authenticated `reports.read` through the existing backend capability guard. OWNER and MANAGER already have it; pure CASHIER/KITCHEN/DISPATCH and their operational unions do not. No grant migration or privileged role-name bypass is introduced. Dashboard and Reports links use the same capability; staff Admin remains controlled by user-management capabilities.

- `GET /api/dashboard`: period, Sales report, Payments report, explanation aggregates, top five Items, Operations.
- `GET /api/reports/sales`: period, summary, serviceTypes and trend.
- `GET /api/reports/payments`: period, tender/refund totals/counts and current cohort balances.
- `GET /api/reports/items`: period, paginated effective groups, counts and totals.
- `GET /api/reports/operations`: period, Bill/round/status/amendment/READY metrics.

Query: optional `period`; optional `from` and `to` imply CUSTOM if no preset supplied. A quick preset with custom dates is rejected. Items alone also accepts `sort=QUANTITY|SALES` and positive `page` (1–99999). Unknown fields, repeated/malformed values and GET bodies are rejected by existing input boundaries and DTOs. Shared contracts live in `packages/shared-types/src/reports.ts`; no persistence rows, credentials or unnecessary operational detail are returned.

## Architecture and database

`ReportsModule` owns only aggregate SQL reads of existing Bills, Orders/effective projections, Payments, revisions and status history. Each response uses one REPEATABLE READ, READ ONLY transaction, so its sections share a coherent snapshot during concurrent operational writes. No restaurant/menu advisory write lock, mutation, scheduled ETL, reporting table, migration, materialized view, cache or external service is added. Queries are parameterized; dynamic sorting/time bucketing is chosen only from validated finite options. A local eight-second per-statement timeout and bounded date/page sizes limit query work.

Existing Bill date/order, order Bill/queue, payment Bill, revision order/version and READY-history indexes are retained. The integration fixture measures a four-month, 1,200-Bill dashboard and captures EXPLAIN ANALYZE/BUFFERS for its real SQL, including effective item and status joins. The complete four-month dashboard measured 122 ms in the local integration run; subsequent EXPLAIN ANALYZE instrumentation measured individual queries at approximately 0.05–108 ms. Plans used existing Bill-date/order-Bill/payment-Bill/READY-history indexes and appropriate sequential scans for this mostly selected, small history. These fixture timings are not a production latency guarantee. No new indexes are justified solely by the presence of a reporting screen. Reassess with measured larger histories before adding infrastructure.

## Frontend and LAN behavior

Dashboard: FOOD SOLD (strongest card), BILLS, UNPAID, AVG BILL; separate MONEY RECEIVED (Cash Received / UPI Received / Cash Returned / Net Money Received), specific explanations, Food Sold trend, top items, service mix and collapsed Operations. Nonzero REFUND DUE stays separate. Transaction and open/closed counts remain in Reports. Reports separates Sales/Payments/Items/Operations; period controls are independent of Bills filters. Every chart value is visible as text; CSS bars are decorative and have no external dependency.

Phone stacks sections; tablet and desktop use compact summary grids. Native dates and large labelled controls support touch and keyboard. Manual Refresh is always available; Today refreshes every 60 seconds while visible, historical ranges do not poll. Request sequencing prevents older results replacing newer requests. Loading/error states clear figures and offer retry; report failure does not disable POS/Kitchen. LAN + server + PostgreSQL suffice; no internet call is needed.

## Verification and remaining limitations

`npm run test:integration` includes report money/reconciliation, replacement/reduction/cancellation, multiple rounds, stable snapshots, timezone/midnight, legacy, query validation, permission unions, read-only table fingerprints, pagination and several months of history. `CHROME_BINARY=/path/to/chrome npm run test:reports-browser` runs isolated PostgreSQL fixtures and blocked-external Chromium touch workflows, exact amounts, period navigation, report tabs, live updates, retries and unauthorized navigation. Temporary artifacts use `/tmp/dukanos-reports-*`.

Current balances and effective sales are not historical close-of-day snapshots. No customer, credit, profit/cost, inventory, provider, GST filing, export/PDF, scheduled/email report or comparison analytics exists. Large production histories and physical Android/iOS date pickers, keyboard and assistive technologies require their own validation. Future Reports V2 must preserve these financial and date definitions unless an explicit reviewed decision changes them.

Verification completed 2026-10-01: npm run check, all 133 PostgreSQL tests (14 report tests including their parent), Reports touch/browser suite and all seven existing browser suites passed. Four-class workflows, eight prescribed dimensions plus constrained height, permission checks, external-request blocking and screenshot review passed. The 1,200-Bill fixture returned its complete four-month Dashboard in 122 ms locally; broad and selective-date query plans are captured under `/tmp/dukanos-report-query-plans.json`. No source table fingerprint changed after requesting every report endpoint.

## Runtime troubleshooting

`npm start` runs a compiled API without watch mode. Rebuilding files while that process remains alive can serve the new frontend alongside an old API route registry. If every period returns `Cannot GET /api/dashboard?...`, verify the running process/build and restart the API after building. Do not reset data, change period semantics or weaken authentication. Registered report routes return 401 without a session and require the normal reports.read login.

## Owner-friendly explanation contract

Food Sold = effective commercial value of Bills in selected business dates, including tax/amendments/cancellations. Money Received = event-date Cash + UPI receipts minus CASH returned. It is neither profit nor cash-drawer balance. Different date bases are intentional.

GET /api/dashboard adds `explanation` decimal strings calculated in its PostgreSQL read-only snapshot:

- collectionsForSelectedBills: period receipts for Bills inside the date cohort.
- collectionsForEarlierBills / collectionsForLaterBills: period receipts for Bills dated before/after it.
- refundsForOtherBills: period cash refunds for Bills outside the sales cohort.
- selectedBillCollectionsOutsidePeriod / selectedBillRefundsOutsidePeriod: other-date events for Bills inside the cohort.

UI combines these with existing outstandingDue, refundDue and cashRefunds, e.g. ₹650 received from earlier Bills and ₹200 still unpaid. It does not invent an arithmetic bridge. Legacy unknowns retain a review explanation. Detailed report endpoints/calculations remain unchanged.

Rollover changes only session counts. CLOSED Bills stay in sales/items/balance reports; later receipts stay in event-date cash flow. Today's UNPAID does not import yesterday's balance. CLOSED never implies PAID. Customer Ledger remains future work.

## Dashboard refinement verification (2026-10-02)

`npm run check` passed (11 API/unit and 18 frontend unit tests); all 146 PostgreSQL integration tests passed. The 1,200-Bill four-month Dashboard including explanation data completed in 123 ms locally; this is a fixture measurement, not a production guarantee. Added coverage verifies older ₹650 receipts separately from current food, partial ₹500/₹300 settlement, other-date receipts/refunds and unchanged financial projections across rollover.

Reports browser verification passed eight required sizes plus 390×420 and complete touch workflows at 390×844, 768×1024, 1024×768 and 1440×900. Checks include simple labels, precise detailed Reports, specific mixed explanations, historical payment/refund forms, cached reminder removal, periods, retry and permissions. External traffic was blocked; screenshots of financial explanations and mobile/tablet/desktop layouts were reviewed. Physical-device limitations above remain.

Read-only local verification after rollover still returned Last 7 Days Food Sold ₹360, Cash Received ₹1,010, UPI Received ₹530, Cash Returned ₹440 and Net Money Received ₹1,100. The explanation identified ₹740 collected for earlier Bills. Those three period Bills were CLOSED, without changing sales or money.

All seven existing browser regression suites also passed: responsive shell, Menu/POS, Kitchen, Dispatch, Bills, operational alerts/audio and amendments/refunds. This milestone does not start Customer Profiles or Customer Ledger.

## Recorded Expenses

Reports → Expenses uses GET /api/reports/expenses with the same reports.read requirement and period validation. Response contains period, total/cash/upi decimal strings, active count, categoryId/name/amount/count groups and daily businessDate/amount trend including zero days. Only ACTIVE expenses count; voids restate their original date. Category names are selected-period snapshots grouped by stable category ID.

Dashboard adds recordedExpenses from the same coherent read snapshot and a separate RECORDED EXPENSES card. Existing sales, collections/refunds, net received and Bill balances are unchanged. CASHIER's expenses.read/create grants permit entry/list totals, not this analytics endpoint. Recorded expenditure is incomplete business cost; no profit calculation. Future Daily Owner Report can consume this model directly; delivery remains deferred.
