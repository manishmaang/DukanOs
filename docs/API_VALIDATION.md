# Implemented API input audit

## Strategy

All controller endpoints use the global Nest ValidationPipe with class-validator/class-transformer DTOs: transform=true, whitelist=true, forbidNonWhitelisted=true, forbidUnknownValues=true, and implicit scalar conversion disabled. Invalid DTOs return `{code: "INVALID_INPUT", message: "Request fields or values are invalid."}` without submitted values, password fields, objects or stack traces. Domain errors such as INVALID_ROLE_COMBINATION and INVALID_MENU_PRICE remain specific.

InputBoundary declares transport contracts: JSON mutations require application/json and an object; image uploads require multipart/form-data. Other endpoints accept no body. Queries are rejected unless the route explicitly declares QueryInput and binds a validated Query DTO. This prevents ignored inputs on endpoints which have no DTO parameters. New endpoints must declare their body/query contract as well as capabilities. Empty body means no bytes, not a JSON object. No Joi/Zod or implicit conversion is used.

JSON body-parser failures, unsupported encodings and bodies above the existing 100 KiB JSON limit produce sanitized 400/415/413 responses instead of 500. Multipart allows one image, no text fields, maximum 5 MiB. UUID route pipes reject malformed identifiers. Channel parameters/query values match the configuration code grammar, then the domain verifies existence/activation. Query arrays, duplicate keys and unexpected filters are rejected. There is no pagination/search API yet; UI search remains local.

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

GET /bills accepts only optional search string <=80 and after UUIDv4 (known cursor); max 100 results. GET /bills/:id has no query/body and validates UUIDv4. POST /bills/:id/payments validates JSON {requestId UUIDv4, method CASH|UPI, amount decimal string with <=12 integer digits and <=2 decimals}; backend requires >0 and <=current due. POST /bills/:id/close accepts no body/query. All unknown fields, arrays/scalar bodies, nulls and unsupported methods/types are rejected through existing NestJS DTO/input guards. Financial reads/collection/closure use distinct capabilities and mutation transactions recheck active session/grants. Pure Kitchen/Dispatch cannot use financial-detail APIs.

## Confirmation payments and alerts (013)

POST /orders/counter/quote shares ConfirmOrderDto and strict boundaries; creates no operational records. Confirmation optionally accepts nested nonnull payment {expectedDue,cash,upi}; decimal strings only, scale <=2, expectedDue up to 16 integral digits, tender amounts up to 12. Authoritative equality/positive sum/current due enforced under lock. Unknown price/payment fields fail, and changed review amounts return PAYABLE_CHANGED (409).

GET /reminders/active and /kitchen/timers reject query/body. Reminder configure accepts only integer intervalMinutes 1–1440; snooze requires positive integer version. Timer create accepts UUIDv4 requestId, nonblank string label <=120, integer durationSeconds 60–86400 and optional nonnull UUIDv4 orderId/orderItemId; item ownership/current Kitchen status is checked server-side. Timer acknowledge/cancel are bodyless (even {} rejected), UUIDv4 and permission guarded. All mutations require existing CSRF header and recheck live capability/session under lock. No client due timestamp/status/actor/financial override is accepted.
