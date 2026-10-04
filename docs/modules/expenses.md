# Restaurant Expenses

## Purpose and boundary

An Expense records restaurant money spent, independently of customer Bills, collections and refunds. Recorded Expenses includes only expenditure entered into DukanOS; it is not complete business cost, inventory consumption or profit. No expense operation writes customer payments, changes Bill balances or alters Food Sold / Money Received.

ExpensesModule owns entry, categories, voids and local receipt metadata/storage. Reports reads its aggregates. No supplier account, inventory, payroll, credit, customer, invoice, messaging or scheduling subsystem is added.

## Entities and database

Migration 017 adds expense_categories, expense_category_audit, expense_receipts and expenses. Categories have UUID, name, active flag, version and timestamps; normalized names are unique. The migration creates ten configuration categories: Vegetables / Raw Material, Bread / Bakery, Staff Food / Tea, Packaging, Gas / Fuel, Cleaning, Maintenance, Transport, Utilities and Miscellaneous. No fake expense is seeded.

Expenses store UUID, business_date, restaurant_timezone, positive precise numeric amount, category FK and human-readable category_name_snapshot, CASH/UPI payment_method, optional vendor (120 characters), note (500), receipt FK, recorded_by/time, actor-scoped request UUID/hash, ACTIVE/VOIDED status and immutable void actor/time/reason/note/request identity. Public money uses decimal strings; BigInt paise helpers normalize it. Bounds are INR 0.01–999999999999.99, at most two fractional digits; PostgreSQL checks reject excess scale rather than rounding silently.

Original amount/category/date/method/actor/receipt never change. Category rename does not rewrite old expense labels. There is no hard-delete endpoint. Database triggers protect expense identity and original values, category history and attached receipt metadata. Category changes append before/after JSON audit with authenticated actor/time, use expected version and never delete records.

## Dates and lifecycle

New entry defaults to the current PostgreSQL RestaurantClock date in configured RESTAURANT_TIMEZONE (default Asia/Kolkata). Omitted businessDate is resolved after taking the write lock, not from browser time. The normal Today form omits it; deliberately selected historical dates are explicit. Current date and earliest allowed date come from the backend. Historical entry is limited to today and the previous 30 calendar business dates, inclusive; future dates are rejected. This is an entry policy, not a restriction on historical reads. Database checks tie entry date to its captured recording time/timezone.

ACTIVE → VOIDED is the only record transition. OWNER/MANAGER capability holders void incorrect entries and create a replacement if necessary; no in-place correction or automatic replacement is performed. Reasons: DUPLICATE_ENTRY, WRONG_AMOUNT, WRONG_CATEGORY, NOT_A_BUSINESS_EXPENSE or OTHER. OTHER requires explanatory text; other reasons allow a note. Voiding excludes the original from effective totals but preserves amount, snapshot, creator, receipt and void audit. A void is a record correction, not a claim that a vendor returned money. There is no actual vendor-refund ledger.

## API and capabilities

All routes use the existing authenticated session, mutation header, strict DTO whitelist, query/body contracts and UUID validation. Prefix `/api`:

- GET /expense-categories: configuration with currentBusinessDate, earliestBusinessDate, timezone and active/inactive category records; expenses.read.
- POST /expense-categories: `{name}`; expense_categories.manage.
- PATCH /expense-categories/:id: `{name,active,version}`; expense_categories.manage. Stale version returns STALE_EXPENSE_CATEGORY.
- GET /expenses: default Today list, effective summary, categories, period and bounded pagination; expenses.read.
- GET /expenses/:id: original entry, receipt URL, creator and optional void audit; expenses.read.
- POST /expenses: `{requestId,amount,categoryId,paymentMethod,businessDate?,vendor?,note?,receiptKey?}`; expenses.create.
- POST /expenses/:id/void: `{requestId,reason,note?}`; expenses.manage.
- POST /expenses/receipts: multipart `image`, one file and no text fields; expenses.create.
- GET /expenses/receipts/:key: authorized local WebP image; expenses.read.
- GET /reports/expenses: aggregate reporting model, separately requires reports.read.

OWNER/MANAGER receive all four expense capabilities. CASHIER receives expenses.read/create, including operational entry/list/filter totals, but no category management, void or Reports grant. KITCHEN/DISPATCH receive none by default. Multi-role unions still apply. Expense data-entry permission does not confer owner analytics. Existing permissions are unchanged.

## Queries and reporting

List accepts period TODAY/YESTERDAY/LAST_7_DAYS/THIS_MONTH/CUSTOM, paired from/to, optional categoryId, paymentMethod CASH/UPI, status ACTIVE/VOIDED, literal case-insensitive search (vendor/note/original or current category name), and page. Date ranges are inclusive and bounded to 366 days using the same shared period resolver as Reports. Query arrays, unknown fields, invalid dates and incompatible preset/custom combinations are rejected. Fifty entries per page, deterministic business_date/created_at/UUID descending; hasMore indicates another page. Pages are separate snapshots, not a frozen export.

List totals apply its filters and include ACTIVE entries only. VOIDED-filter totals therefore equal zero even though original amounts remain visible in entries. Reports aggregates total, cash, upi, count, categories and daily trend, including zero days. Stable category IDs group entries; group labels use the latest recorded snapshot within the selection. Category deactivation never hides historical records or aggregates.

Dashboard adds only selected-period RECORDED EXPENSES. No subtraction from sales, collections, refunds or Net Money Received. Reports → Expenses offers Total Recorded Expenses, Cash Expenses, UPI Expenses, category totals and Expenses by Day. All read sections use a single REPEATABLE READ, READ ONLY transaction with bounded inputs. Historical voids restate effective totals on the original expense date; these are not immutable close-of-day accounting snapshots.

## Concurrency and idempotency

Use existing restaurant advisory transaction lock 742019323, then revalidate live session/capability. Category activation, receipt ownership/existence and date eligibility are checked under lock. Expense insert triggers independently validate active category/name, captured date and receipt ownership. Category deactivation racing a saved form rejects the new expense if it wins first.

Creation request identity is `(recorded_by,request_id)`, permanently bound to normalized amount/category/method/date intent/vendor/note/receipt. Retry returns the original record before checking later category/date changes; changed intent conflicts. Default-date intent is stored in the hash as omitted, so a delayed replay across midnight never creates a second expense. Void has separate actor/request identity; same intent replays, conflicting payload or a different attempt on an already-voided entry is rejected.

Frontend persists the exact pending create request in per-user tab sessionStorage before sending. A lost response retains Retry Expense and locks editing until resolved; double clicks also have a synchronous in-flight guard. Known rejected requests allow correction. Closing the tab loses this recovery record: inspect existing entries before making a replacement. No disconnected writes are queued.

## Receipt storage and cleanup

Receipts are optional, local and separate from Menu assets: DUKANOS_DATA_DIR/uploads/expenses, default ~/.local/share/dukanos/uploads/expenses. APIs expose opaque UUID keys and authorized URLs, never filesystem paths. Actual JPEG/PNG/WebP content must match MIME; maximum input 5 MiB / 24 megapixels, still image only. Sharp rotates orientation, strips metadata, resizes within 2400×2400 without enlargement and writes WebP quality 90 (maximum output 5 MiB), prioritizing printed-text readability over menu-thumbnail size. PDF/SVG/animated files are not accepted.

Upload stages a private file, then commits uploader/dimension metadata under authorization. Failed metadata insertion compensates the file write. Expense creation can attach only its actor's existing unattached receipt; one receipt belongs to one expense. Missing files produce explicit errors. Attach and cleanup share the restaurant lock. Attached/voided receipts remain for audit, with no replacement/removal endpoint. Retrieval requires expenses.read; unattached stages are visible only to their uploader. Responses use private no-store, nosniff and restrictive CSP.

Unused stages (including abandoned/replaced pre-save choices), crash remnants and temporary files are reclaimable after 24 hours using `npm run expenses:cleanup -- --dry-run`, then `npm run expenses:cleanup`. The command is repeat-safe and never deletes attached receipts; no cleanup runs at startup. File removal failures are reported/deferred for retry. Database plus persistent receipt directory must be preserved together; no backup feature is implemented here.

## UI and responsive behavior

Expenses workspace defaults Today with summaries and entry cards. Add Expense uses a large amount input/numeric keyboard hint, category, Cash/UPI buttons and clearly labelled server date; vendor/note/receipt are optional. Historical selection is visibly called out. Success shows original facts and allows Add another expense. Category management and void controls appear only with capabilities. Void audit and receipt remain visible afterward. Native image input supports browser camera/file selection where available without native APIs.

Forms use natural document flow, wrapping labels and 48px controls, with no desktop-only actions. Filter/category/report layouts collapse on phones; long text and short heights retain reachable actions. Physical camera, keyboard, image readability on actual printer receipts and assistive-technology smoke checks remain necessary beyond desktop Chromium emulation.

## Future Daily Owner Report and messaging

GET /reports/expenses provides period/timezone/asOf, total, cash, upi, count, per-category amount/count and daily amounts. The future Daily Owner Report can combine this with existing food sales, refunds and effective item/variant quantities without querying raw expenses or recalculating money in messaging code.

Daily Report Generator and Email Delivery are now implemented in DailyReportsModule with an EmailDeliveryAdapter; WhatsApp remains a future adapter. Owner daily reports, customer invoices, order updates and credit reminders are transactional purposes; marketing campaigns are distinct and will require consent, opt-out and preferences. Build a shared WhatsApp integration when customer/profile/invoice requirements are known. WhatsApp API/Web automation, customers, Khata and marketing remain explicitly deferred.

## Verification

The full 158-test PostgreSQL suite passes, including exact amounts, permission boundaries, immutable records, category/version races, revoked sessions, idempotency, restaurant midnight, receipt ownership/validation and cleanup. Isolated expense browser workflows cover entry, receipts, duplicate submission, category maintenance, void audit, historical dates, filters and report reconciliation. Existing Reports and responsive regressions pass with external traffic blocked. Workflows were exercised at 390×844, 768×1024, 1024×768 and 1440×900; layout checks also cover 360, 430, 1280 and 1600 widths plus 390×420. These are Chromium emulation results, not physical-device certification.

## Daily Report integration

Daily Reports now stores active expense totals, category snapshots and compact entries in immutable report JSON. Later backdating/voiding updates live expense reports only. Explicit report regeneration captures a new version; older report detail/resend never recalculates expenses. Receipt images remain local and are not embedded in email. See [Daily Reports](daily-reports.md).
