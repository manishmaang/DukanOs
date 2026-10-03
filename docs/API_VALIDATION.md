# Implemented API input audit

## Strategy

All controller endpoints use the global Nest ValidationPipe with class-validator/class-transformer DTOs: transform=true, whitelist=true, forbidNonWhitelisted=true, forbidUnknownValues=true, and implicit scalar conversion disabled. Invalid DTOs return `{code: "INVALID_INPUT", message: "Request fields or values are invalid."}` without submitted values, password fields, objects or stack traces. Domain errors such as INVALID_ROLE_COMBINATION and INVALID_MENU_PRICE remain specific.

InputBoundary declares transport contracts: JSON mutations require application/json and an object; image uploads require multipart/form-data. Other endpoints accept no body. Queries are rejected unless the route explicitly declares QueryInput and binds a validated Query DTO. This prevents ignored inputs on endpoints which have no DTO parameters. New endpoints must declare their body/query contract as well as capabilities. Empty body means no bytes, not a JSON object. No Joi/Zod or implicit conversion is used.

JSON body-parser failures, unsupported encodings and bodies above the existing 100 KiB JSON limit produce sanitized 400/415/413 responses instead of 500. Multipart allows one image, no text fields, maximum 5 MiB. UUID route pipes reject malformed identifiers. Channel parameters/query values match the configuration code grammar, then the domain verifies existence/activation. Query arrays, duplicate keys and unexpected filters are rejected. Orders and Bills validate bounded cursor/filter queries; catalog UI search remains local.

## Reviewed boundaries

| Family                       | Implemented boundaries                                                                                             | Checks                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health                       | GET /health, /health/ready                                                                                         | No body/query; readiness errors sanitized. Environment config is local-only, with no HTTP config endpoint.                                                                                                                  |
| Auth                         | POST /auth/login, /auth/change-password; GET /auth/me; POST /auth/logout                                           | Strict DTO types/lengths, no unknown keys; no body/query for me/logout. Login normalizes username and preserves generic credential failures; passwords never trimmed.                                                       |
| Staff                        | GET/POST /users; PATCH /users/:id/access                                                                           | UUID, username grammar, bounded name/password/role strings, role array ≤5, actual boolean, positive PostgreSQL-int version, reason bounds. Domain rejects blank names/reasons, empty/duplicate/unknown/exclusive role sets. |
| Password resets              | GET /users/password-reset-targets; POST /users/:id/password-reset                                                  | UUID, new-password/reason bounds, positive bounded version; target-role/session policy remains authoritative.                                                                                                               |
| Menu reads                   | GET /menu?channel=CODE, /menu/counter, /menu/channels, /menu/admin, /menu/categories, /menu/items, /menu/items/:id | Only the channel read accepts query fields; channel grammar/existence, UUID and capability checks. Counter includes active priced sold-out portions; default channel read remains sellable-only.                            |
| Categories                   | POST /menu/categories; PATCH /menu/categories/:id                                                                  | Name/text bounds, actual optional boolean (null rejected), version, UUID; trimmed nonblank/unique domain names.                                                                                                             |
| Dishes/portions              | POST /menu/items; PUT/PATCH /menu/items/:id; POST /menu/items/:id/variants; PATCH /menu/variants/:id               | UUIDs, ≤100 nested portions, ≤100 channel settings per portion, nested DTOs, bounded names/text, strict booleans, versions; duplicate/foreign references and incomplete aggregate writes rejected transactionally.          |
| Pricing/channel availability | PUT /menu/variants/:id/channels/:code/price; PATCH .../availability                                                | UUID, channel grammar/existence, decimal string ≤32 chars, exact nonnegative INR/scale checks, boolean, bounded itemVersion and active references.                                                                          |
| Counter availability         | PATCH /menu/counter/items/:id/availability                                                                         | version, boolean available, optional UUID variantId; no channel/price/activation fields accepted; only active priced Counter portions of that dish may change.                                                              |
| Media                        | POST /menu/images; GET /menu/images/:key                                                                           | One bounded file, content/MIME agreement, full decode, pixel/frame limits, generated UUID path; read permissions and assignment checks. Filename extensions are not trusted; originals never become executable assets.      |

All dynamic query values remain SQL parameters. Catalog ordering interpolates only an internal ASC/DESC choice. Database constraints remain in force; HTTP validation does not replace them. No applied migration was edited.

## Gaps corrected

Previously unused query/body fields were ignored on endpoints without DTO bindings; channel query/route inputs lacked structural validation; optional active booleans silently accepted null; full-dish variant arrays and version integers lacked upper bounds. Parser errors could be classified as 500. These boundaries now reject malformed inputs consistently.

Staff create/access mutations previously rechecked capabilities after the staff lock but not the requesting session. HTTP callers now pass their session hash for transactional revalidation, matching password/menu mutations. Trusted local bootstrap/test service calls remain non-HTTP operations. Guards still enforce session cookies, per-request permission unions and X-DukanOS-Request: 1 on unsafe methods.

## Security scope and limitations

This is an input and obvious-protection audit, not a penetration test. Existing scrypt hashing, opaque hashed sessions, HttpOnly/SameSite cookies, production Secure cookies, login/password throttles and no permissive CORS remain. TLS/proxy deployment, network controls, backup automation, MFA/device management and broader abuse/load testing remain pending. Authorized file uploads are size/pixel/staging bounded, but there is no global disk quota or upload-rate service. Filesystem/database consistency is compensating cleanup, not an atomic distributed transaction. No raw secrets or internal errors are returned.

## Orders Core

POST /orders/counter: JSON ConfirmOrderDto, UUIDv4 requestId, 1–100 nested lines, UUIDv4 variantId, integer quantity 1–99, optional nonnull plain instruction ≤500 characters. No supplied price/status/tax/source fields accepted. GET /orders accepts only optional status enum, calendar businessDate and UUIDv4 after cursor; result bounded to 100. GET /orders/:id uses UUIDv4 pipe; token route validates calendar date and positive PostgreSQL integer token. GET /orders/configuration is body/query-free. Normal auth/CSRF/capabilities and sanitized errors apply. ITEM_NOT_AVAILABLE includes affected line in safe plain text; no error metadata passthrough was added.

## Kitchen

GET /kitchen/orders and /kitchen/production accept no body or query and require kitchen.read. POST /kitchen/orders/:id/start and /ready accept no body/query (even `{}` is rejected), validate UUIDv4, require kitchen.update and the mutation header, and revalidate session/capability after transaction-lock waiting. Dedicated operations cannot accept arbitrary status or financial changes. Stale/FIFO conflicts return specific 409 business errors and cause frontend authoritative refetch. Read models contain operational snapshots only.

## Dispatch

GET /dispatch/orders requires dispatch.read and rejects body/query input. POST /dispatch/orders/:id/complete requires dispatch.complete, UUIDv4, the mutation header and no body/query (including empty JSON). Orders rechecks the live session/capability inside the transaction and permits only READY→COMPLETED. Duplicates/wrong states produce sanitized 409 errors; queue reads expose operational snapshots only. No arbitrary status input exists.

## Bills/Payments (012)

POST /orders/counter additionally accepts either billId (UUIDv4) or serviceType (DINE_IN/TAKEAWAY) with optional reference (string <=80); service/reference cannot accompany billId. New confirmations without service/bill context fail. Historical committed requests can replay their original fingerprint.

GET /bills accepts only optional search string <=80, after UUIDv4 (known cursor), and paired fromBusinessDate/toBusinessDate strings. Dates must be real YYYY-MM-DD dates (year >=0001), From <= To; malformed, repeated or one-sided ranges are rejected. No search/range defaults server-side to today in RESTAURANT_TIMEZONE; search alone spans history, range restricts search inclusively. Numeric/#numeric searches use exact Bill numbers, other text literal reference matching, never Kitchen tokens. Results include OPEN/CLOSED, sorted date/opened_at/UUID descending; max 100 results. Summary/detail adds currentBusinessDate and canChangeFood. GET /bills/:id has no query/body and validates UUIDv4. POST /bills/:id/payments validates JSON {requestId UUIDv4, method CASH|UPI, amount decimal string with <=12 integer digits and <=2 decimals}; backend requires >0 and <=current due. POST /bills/:id/close accepts no body/query. All unknown fields, arrays/scalar bodies, nulls and unsupported methods/types are rejected through existing NestJS DTO/input guards. Financial reads/collection/closure use distinct capabilities and mutation transactions recheck active session/grants. Pure Kitchen/Dispatch cannot use financial-detail APIs.

## Confirmation payments and alerts (013)

POST /orders/counter/quote shares ConfirmOrderDto and strict boundaries; creates no operational records. Confirmation optionally accepts nested nonnull payment {expectedDue,cash,upi}; decimal strings only, scale <=2, expectedDue up to 16 integral digits, tender amounts up to 12. Authoritative equality/positive sum/current due enforced under lock. Unknown price/payment fields fail, and changed review amounts return PAYABLE_CHANGED (409).

GET /reminders/active and /kitchen/timers reject query/body. Reminder configure accepts only integer intervalMinutes 1–1440; snooze requires positive integer version. Timer create accepts UUIDv4 requestId, nonblank string label <=120, integer durationSeconds 60–86400 and optional nonnull UUIDv4 orderId/orderItemId; item ownership/current Kitchen status is checked server-side. Timer acknowledge/cancel are bodyless (even {} rejected), UUIDv4 and permission guarded. All mutations require existing CSRF header and recheck live capability/session under lock. No client due timestamp/status/actor/financial override is accepted.

## Amendments/refunds (014)

POST /orders/:id/amendments/quote and /amendments require UUIDv4 route/request IDs, integer expectedRevision 0–2147483646, CHANGE/CANCEL, predefined reason, optional nonnull note <=500, <=100 nested lines with UUIDv4 existing line/variant IDs, integer quantity 1–99 and plain instruction <=500. Commit additionally requires lowercase 64-character quoteHash. Unknown price/status/actor/tax fields and null/malformed structures fail. Domain checks enforce unique surviving lines, nonempty CHANGE/empty CANCEL, no increases/additions, current revision/QUEUED/open Bill, no active associated timer, replacement sellability and quote equality. Read history rejects body/query and requires financial read capabilities.

POST /bills/:id/refunds accepts only UUIDv4 requestId and positive decimal-string amount (<=12 integral digits, <=2 decimals). No method/type override is accepted. Current refund_due caps the receipt under the shared lock, and database constraints independently require CASH and immutable ledger. Same actor/key with different event type or payload conflicts.

Order quote/confirmation and new amendment quote/commit additionally require current-day OPEN parent Bills; another business date yields BILL_NOT_CURRENT_BUSINESS_DATE (409). This does not restrict successful idempotent replay, financial reconciliation or historical reads.

## Dashboard / Reports V1

GET /dashboard and /reports/sales, /payments, /items, /operations require reports.read and reject request bodies. ReportPeriodDto validates optional enum period and YYYY-MM-DD from/to strings; domain checks reject impossible dates, one-sided/custom-conflicting ranges, reversed dates and ranges longer than 366 inclusive days. Items alone permits QUANTITY/SALES sort and page 1–99999, with fifty rows per page. Nulls, repeated query arrays and unknown keys fail existing strict validation. SQL parameters handle date/page values; finite validated choices select ordering only. Aggregates execute in read-only repeatable-read transactions with an eight-second per-statement timeout. No endpoint can alter source records.

## Rollover and Dashboard explanation contracts

No new writable API/capability. Bill responses add nullable closureReason (MANUAL / BUSINESS_DAY_ROLLOVER); closedAt is actual processing time. Clients cannot submit system closure identity/reason. Financial POSTs accept rollover-closed Bills under existing permission/amount/idempotency/due checks; manual closures remain protected. Food/manual-close checks remain strict. Dashboard adds exact-decimal explanation aggregates; period/unknown-field validation is unchanged.

## Expense endpoints

Expenses uses JsonInput/QueryInput/MultipartInput and class-validator DTOs with no implicit money conversion. Create requires UUIDv4 request/category, positive decimal string <=999999999999.99 with at most two fractional digits, CASH/UPI, optional real YYYY-MM-DD (today or previous 30 restaurant dates), vendor<=120, note<=500, optional UUIDv4 receipt. Category PATCH requires name/active/version; whitespace-only names, stale versions, duplicate names and inactive references are rejected. Void requires UUID request, finite reason and optional 500-character note; OTHER requires nonblank explanation. Original facts are not editable.

List supports existing bounded report periods plus category/method/status/search<=120 and positive bounded page; unknown/repeated fields and GET bodies fail. Receipts accept one image/no fields up to 5 MiB, validate actual still JPEG/PNG/WebP <=24MP, and are retrieved only with expenses.read. Stages belong to uploader; attachment and cleanup serialize. Reports/expenses stays reports.read despite cashier entry permission.
