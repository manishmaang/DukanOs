# Daily Owner Reports

## Purpose and boundary

DailyReportsModule captures one completed restaurant business date as an immutable structured communication snapshot. Reports remains live analytics. Email delivery is separate from report calculations and does not change Bills, orders, payments, refunds, expenses or Kitchen state. No profit, customer, inventory, PDF, WhatsApp, campaign or deployment feature is introduced.

## Content and source semantics

ReportsService.dailySnapshot reuses existing salesData/paymentsData, food CTE and ExpensesService.totals on one transaction connection. Food Sold sums current effective commercial totals of the Bill-date cohort, including snapshotted tax; it never sums payments or reads current Menu prices. Cash Returned sums actual cash refund ledger events within restaurant-local midnight boundaries, including older-Bill refunds paid that day. Unpaid refund entitlement is excluded. Recorded Expenses sums ACTIVE expenses for their recorded business date and retains historical category labels, vendor, method and optional plain-text note. Receipt images/paths are never included in the snapshot/email.

Best seller groups all effective non-cancelled portions by stable menu item ID. Highest total quantity wins, then highest exact pre-tax line sales, then ascending item UUID. All sold variants of the winning item are included, grouped by stable variant UUID with effective sale snapshot labels. Replacements count only replacement lines, reductions use final quantities, and cancelled rounds contribute no food. Item display label uses latest original confirmation with deterministic order ID/position ties. Quantities and INR amounts are decimal strings; arithmetic uses SQL numeric/BigInt paise. No rupee rounding.

Zero activity retains Food Sold / Cash Returned / Recorded Expenses 0.00 and explicit no-sales/no-expenses messages.

## Snapshots and versions

Migration 018 adds daily_reports with UUID, date, version, source AUTOMATIC/MANUAL, generation time/actor, reason, request identity and JSONB snapshot schemaVersion 1. The JSON contains businessDate/timezone, foodSold, cashReturned, recordedExpenses, expenseCategories, expenseEntries and bestSeller with variants. Database UPDATE/DELETE triggers forbid rewriting a version. UNIQUE(business_date,version) protects allocation. Delivery state lives elsewhere.

Each generation uses one REPEATABLE READ transaction for source queries, snapshot insert and automatic delivery enqueue. Dedicated advisory lock 742019324 serializes report generation; unique/serialization conflicts retry the entire transaction up to five attempts to obtain a fresh consistent snapshot after contention. Manual mutation authorization also rechecks live session/capability through the existing restaurant lock. Original source records are read only.

First generation creates v1. Repeated initial/automatic generation returns existing v1. Explicit Regenerate requires a nonblank reason and inserts latest version + 1 with actor/time. Actor/request UUID and canonical intent prevent duplicate network retries; changed intent conflicts. Historical corrections never trigger automatic regeneration or revised email. Regeneration does not send automatically.

Example: v1 expenses 2000.00; a legitimate historical Bread entry of 500.00 changes live Reports to 2500.00 while stored v1 stays 2000.00. Explicit regeneration creates v2 at 2500.00. Both versions remain accessible. Resend v1 uses 2000.00; send v2 uses 2500.00 and a REVISED DAILY REPORT label. See the completed design reasoning in [preflight](../plans/daily-owner-report-preflight.md).

## Scheduling and installation boundary

HTTP bootstrap starts the worker after existing Bill rollover and after the server begins listening. CLI/test application contexts do not automatically start it. A local 60-second check runs rollover, chronological report catch-up and delivery work. Failures log generic messages and retry without blocking POS/Kitchen startup. Shutdown stops the timer and awaits the current cycle.

The PostgreSQL restaurant clock is authoritative. DAILY_REPORT_DELAY_MINUTES defaults to 5 (0–1440): eligibility is midnight after each report date in RESTAURANT_TIMEZONE plus that delay, never browser midnight. Today cannot be finalized even manually. No preview is implemented.

On the very first worker initialization, persist start_date and next_date as yesterday. This deliberately avoids emailing all pre-installation history. From that durable boundary, catch up missing completed days in chronological batches of seven per tick, including zero-activity dates. Downtime after initialization loses no scheduled dates. Older dates can be generated explicitly. Successful generation advances the cursor conditionally; a crash between generation and cursor update safely replays v1. Multiple processes cannot allocate duplicate date/version or automatic recipient jobs. A manual v1 already present is retained and is not automatically re-emailed by catch-up.

## Settings, permissions and APIs

OWNER/MANAGER receive daily_reports.read/manage/send. Operational roles receive none. Backend capabilities remain authoritative. Settings store enabled flag (default OFF), up to ten distinct recipient addresses (domain lowercased, mailbox case preserved; case-insensitive duplicate detection) (default none), version and catch-up dates. No recipients are derived from staff accounts. Edits require expected version and append before/after actor/time audit. Enabled automatic email requires at least one recipient. SMTP secrets remain environment-only.

Prefix /api/daily-reports:

- GET ?page=1: newest dates/versions, 25 per page and hasMore; read.
- GET /:id: exact stored snapshot and delivery history; read.
- POST: {requestId,businessDate}, completed-date initial generation; manage.
- POST /:id/regenerate: {requestId,reason}; manage.
- GET /settings; PATCH /settings {enabled,recipients,version}; manage.
- POST /:id/send: {requestId,confirmResend}; send.
- POST /test-email: {requestId,recipient}; send; recipient must already be configured.
- GET /deliveries: latest 50 jobs, including test emails; read.
- POST /deliveries/:id/retry: {requestId}; send.

Strict DTOs, body/query contracts, UUID pipes, CSRF header and bounded plain text follow existing conventions. Real calendar dates/current-day restriction are checked server-side. All report mutations require a current session inside the transaction.

## Delivery and audit

report_deliveries binds immutable report_id, recipient, channel EMAIL, kind/source, requesting actor and request identity. Each recipient gets its own job; addresses are not exposed as a shared To list. Automatic (report_id,recipient) uniqueness prevents repeated enqueue. Manual requests are actor/key idempotent. Current recipients are captured at request time, including resends. Changes never rewrite previous delivery recipients or report references.

PENDING → SENDING → SENT / RETRY_PENDING / FAILED. A short transaction claims an eligible job with FOR UPDATE SKIP LOCKED, a claim UUID and two-minute lease. SMTP runs outside database transactions. A 30-second heartbeat extends healthy claims. Success/failure updates only the matching claim and appends immutable report_delivery_attempts. An expired claim appends LEASE_EXPIRED/DELIVERY_UNCERTAIN and can be reclaimed. Worker batches send at most ten jobs per tick; process-local calls coalesce.

Transient/network/auth failures retry after 1, 5, 15, 30 then capped 60 minutes. Recipient rejection becomes FAILED for explicit operator retry. Pending state, counts and next-attempt timestamps survive restart. Manual retry keeps report/recipient/job identity and appends report_delivery_actions actor/time; it cannot retry a SENT or currently SENDING job. An intentional confirmed resend creates new jobs without changing original SENT records. The database protects delivery identity and immutable SENT history, plus attempt/action/settings audit records.

Application idempotency prevents obvious duplicate queued jobs. SMTP acceptance can be uncertain if the process/network fails after transmission; exactly-once recipient delivery is not guaranteed. SENT means the SMTP server accepted the message, not proof of inbox arrival/read. Message-ID is stable per delivery job; intentional resends have new IDs.

## SMTP and presentation

EmailDeliveryAdapter uses provider-neutral Nodemailer SMTP. Configure SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE (false/default or true for implicit TLS), optional paired SMTP_USERNAME/SMTP_PASSWORD, EMAIL_FROM_ADDRESS and EMAIL_FROM_NAME (default DukanOS). Remote SMTP requires certificate-validated implicit TLS or STARTTLS; unencrypted transport is permitted only for loopback test/local relay hosts. Connection/greeting/DNS/socket timeouts are bounded; no protocol/debug logging, URL fetching or file attachments. Configuration errors contain no secret values. Absent SMTP_HOST means NOT CONFIGURED: application/report generation continues and existing email jobs wait without repeated send attempts. Turning automatic email OFF affects future enqueue, not already explicitly queued jobs.

Email subject identifies date and revision; HTML is escaped, single-column, inline-styled, asset-free and paired with plain text. Both render solely from stored structured values. Full receipt images are excluded. Test Email is a durable TEST job with no report row, visible in settings history; its result verifies actual transport acceptance. SMTP errors are mapped to SMTP_AUTH_FAILED, RECIPIENT_REJECTED or SMTP_UNAVAILABLE without raw provider text/credentials. Adapter follows [Nodemailer SMTP documentation](https://nodemailer.com/smtp).

## UI and recovery

Reports offers Live Reports / Daily Reports. History shows date/version, generation time and delivery statuses; detail shows stored totals, expense categories/entries, winning dish/portions and actor/reason. Settings exposes enabled flag, saved recipients, transport status and test email. Detail has regeneration reason, send/resend confirmation and retry actions. Manual Refresh fetches job progress; no external browser dependency.

Side-effect request identity is saved per-user in tab sessionStorage before POST; uncertain results expose Retry pending request and block another mutation until resolved. Known rejected requests allow correction. Closing the tab loses recovery data: inspect history before deliberately resubmitting. Settings use optimistic version conflict instead of request keys. Natural-flow single-column phone forms, wrapping cards and 48px actions remain usable at tablet/desktop widths and constrained heights.

## Future integration and limits

Structured snapshots can feed a future WhatsApp adapter without re-querying historical source data or importing SMTP concepts. Current runtime/schema/UI exposes EMAIL only. Transactional owner reports, future invoices/order updates/Khata reminders remain distinct from marketing, which requires its own consent/opt-out policy. No WhatsApp API/Web automation, customers, invoices or campaigns are implemented.

No PDF, automatic regeneration after corrections, inbox/bounce tracking, report retention/deletion, current-day final report or production SMTP credentials are supplied. Historical installation backfill is explicit; catch-up starts yesterday on first initialization. Physical mobile/email-client testing and actual provider delivery depend on available devices/configuration.

## Verification record — 2026-10-04

`npm run check` passed; the complete PostgreSQL suite passed 168 tests, followed by a passing targeted 10-test run after final history/normalization changes. Coverage includes the 10000/500/2000 fixture, all portions, replacement/reduction/cancellation, revenue tie-break, v1 immutability after historical addition/void, version contention/replay, permissions, optional SMTP, real loopback SMTP MIME delivery, failure/recovery with a fresh worker, lease expiry, manual retry/resend, recipients and chronological catch-up/delay/zero days. SMTP transport acceptance was verified locally, not with production credentials or an external inbox.

Daily browser workflows passed at 390×844, 768×1024, 1024×768 and 1440×900, with all eight standard sizes plus 390×420. Long item/vendor text and the email HTML were inspected on phone/tablet/desktop; source snapshots, settings and version-specific email actions remain usable. Existing Reports/Expenses and full operational responsive browser regressions also passed after correcting the harness logout wait. External traffic remained blocked except the loopback SMTP fixture.

Local migration and worker startup preserved all 29 preexisting source-table fingerprints and three upload files. One real previous-day snapshot was generated and no mail queued, as expected with default OFF/no recipients. This verifies local preservation, not a backup implementation.

## Production audit follow-up

The [2026-10-07 audit](../PRODUCTION_READINESS_AUDIT.md) confirms version immutability and passing isolated worker/delivery regressions. That audit identified temporary EENVELOPE classification and readiness/worker-monitoring gaps. The 2026-10-09 hardening follow-up fixes SMTP 4xx recipient classification to SMTP_UNAVAILABLE (retryable) while permanent recipient rejection remains FAILED. Loopback SMTP tests exercise 451 and 550 responses. Existing capped backoff, leases, delivery history and immutable versions are unchanged. Release readiness now checks report schema objects; structured worker events and the local monitor expose stalled/error cycles. Actual SMTP delivery, alert recipients and host monitoring still require deployment-time configuration.

## Previous-day cleanup boundary (019)

The default report delay remains five minutes after midnight, before default 05:00 cleanup. A report already generated/sent can contain food later cancelled automatically. Its stored version and email never change. Review live reports after cleanup, explicitly regenerate with a reason to create v2+, and explicitly send the revision if required. Startup after the cutoff runs cleanup before catch-up generation.

## Manual platform isolation (020)

Manual Zomato/Swiggy orders have no Bill, monetary/tax snapshots, payment, refund or financial amendment. Existing Counter Bill cohorts and customer ledger definitions remain unchanged; platform food cannot enter financial/live/Daily Report totals. Platform cancellation and previous-day cleanup are operational only. Immutable existing report versions are not rewritten. See [Platform Orders](platform-orders.md).
