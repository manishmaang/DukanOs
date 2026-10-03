# Daily Owner Report preflight — 2026-10-04

Status: design verified against existing implementation; implementation and executable verification pending.

## Mandatory snapshot invariants

1. Store structured schema-versioned JSONB in new daily_reports rows: UUID, business_date, restaurant timezone, version, generation timestamp/source/actor/reason, exact decimal foodSold/cashReturned/recordedExpenses, category breakdown, expense entries, best item and all sold variants. No current Menu joins when rendering stored reports.
2. UNIQUE(business_date,version) identifies each immutable version. A dedicated report generation advisory transaction lock serializes allocation; repeatable-read serialization/uniqueness conflicts retry the whole transaction with a fresh snapshot. Initial generation inserts v1 only when no report exists. Explicit regeneration inserts max(version)+1.
3. Database BEFORE UPDATE/DELETE triggers reject changes to daily_reports. No normal application update/delete workflow exists. Delivery state is separate, so sending cannot mutate financial snapshot fields.
4. Regeneration requires authenticated daily_reports.manage, request UUID and nonblank bounded reason; records actor/time. Actor/request identity prevents a network retry creating another revision. Different requests may create successive versions safely. Regeneration never automatically sends email.
5. Existing Reports continues current authoritative effective reads. Daily Report detail reads only the stored snapshot. Corrections do not trigger regeneration or automatic revised emails.
6. Delivery jobs reference the exact daily_reports.id using a restrictive FK and retain recipient, request identity, actor/source, attempts and timestamps. A v1 delivery cannot be reassigned to v2. Recipient configuration changes affect future jobs only.
7. Send/resend renders HTML and plain text from the referenced stored structured snapshot, never from live historical SQL. Intentional resend creates a new audited job; retry preserves the existing job/version/recipient. Revised subjects and bodies include version and REVISED DAILY REPORT.
8. Generation uses one repeatable-read database transaction for all sections plus snapshot/automatic-job insertion. Unique date/version and automatic report/recipient constraints backstop worker/application idempotency. Workers claim jobs atomically with bounded leases; SMTP happens after commit. Lease recovery allows uncertain delivery retries; SMTP cannot guarantee exactly-once recipient delivery.

## Verified current data sources

ReportsService already selects Bills by business_date, sums bill_balances.bill_total including effective tax, reads actual payments REFUND by restaurant-local event window, and uses effective_order_items excluding CANCELLED orders. Its shared food CTE uses stable item/variant IDs and historical labels. ExpensesService totals selects ACTIVE expense business dates and historical category labels. Reuse those query methods/CTEs on the same connection, rather than invoking independent HTTP reports/transactions. Add a dish-level winner over all variants, quantity descending then exact line sales descending then stable item ID; return every sold variant for that winner.

RestaurantClock uses PostgreSQL clock_timestamp and RESTAURANT_TIMEZONE. BillRolloverService runs at HTTP startup and every minute, and ends historical tab sessions without changing finances. Daily generation follows successful rollover, waits a configurable five-minute default after local midnight and never finalizes today. A durable initial scheduling start date and chronological bounded catch-up batches prevent either losing downtime days or accidentally emailing all historical restaurant data on installation. Default start will be the previous completed business date at first worker initialization; later restarts resume the persisted cursor. This installation boundary must be visible/documented; explicitly generated older dates remain possible.

Generation failures must not prevent POS/Kitchen startup. SMTP is optional and isolated behind an Email adapter; absent configuration is visible, reports still generate, and queued mail waits. Email enabled flag defaults OFF with no recipients. No real recipients or credentials are seeded. Network errors are sanitized and persist scheduled capped retries. Database settings are versioned and audited; secrets stay environment-only.

## Controlled conceptual fixture

| Step                                                         | Live Food Sold | Live Expenses | Stored v1                                                       | Stored v2                                                               |
| ------------------------------------------------------------ | -------------- | ------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Generate completed 3 October                                 | 10000.00       | 2000.00       | Food 10000.00, expenses 2000.00, Manchurian 10, Half 4 / Full 6 | absent                                                                  |
| Add legitimate historical Bread expense 500.00               | 10000.00       | 2500.00       | byte-for-byte unchanged                                         | absent                                                                  |
| Explicit regenerate, reason Missing historical expense added | 10000.00       | 2500.00       | unchanged and accessible                                        | Food 10000.00, expenses 2500.00, same quantities; new actor/time/reason |
| Resend v1                                                    | unchanged      | unchanged     | email uses expenses 2000.00                                     | unchanged                                                               |
| Send v2                                                      | unchanged      | unchanged     | v1 delivery remains attached to v1                              | revised email uses expenses 2500.00                                     |

Existing expense triggers permit legitimate historical entry within 30 days and audited voids. Those operations cannot touch new report rows. Same reasoning holds for 3200.00 → 3800.00 after a 600.00 missing expense. A void changes only live and subsequently generated totals. The executable integration suite must assert deep snapshot equality, database update/delete rejection, delivery FK identity, concurrent versions, repeat automatic generation and renderer output.

## Responsive implementation plan

Reports gets Daily Reports history/detail/settings navigation. Phone uses single-column cards and natural document scrolling; tablet portrait retains readable forms; landscape/desktop use bounded content, never a wide accounting table. Controls at least 44px, wrapping recipients/names/reasons, explicit resend confirmation and recoverable request identities. Verify eight required sizes plus short-height forms and actual four-class workflows. Email is single-column, escaped inline HTML with plain text fallback and no external assets.
