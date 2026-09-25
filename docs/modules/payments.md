# Payments

## Purpose and implementation

Record money actually received against an open Bill, with immutable financial history. Bills are parent commercial tabs; Kitchen orders remain separate preparation rounds. CASH and UPI collections, partial/split payment, actor/time history, derived balances and safe retries are implemented in BillsModule/BillsService. There is no card, gateway, QR generation, UPI verification, credit, refund or payment-edit/delete API.

## API and validation

POST /api/bills/:id/payments requires payments.collect + bills.read and accepts `{requestId: UUIDv4, method: CASH|UPI, amount: decimal-string}`. Amount must be positive, at most 999999999999.99 INR, with at most two fractional digits and no signs, exponent or nonfinite notation. Unknown fields, numbers instead of strings, malformed UUIDs/methods and nulls are rejected. Overpayment returns PAYMENT_EXCEEDS_DUE (409) with current due. Closed bills reject new collections. Same-key replays may retrieve an already successful result after bill closure.

## Ledger and financial integrity

Migration 012 payments rows contain permanent ID, bill FK, COLLECTION type, CASH/UPI method, exact numeric amount, authenticated actor, database timestamp and actor-scoped request UUID/hash. Update/delete triggers reject rewriting history. A positive/scale/bounds check avoids silent numeric rounding. Bill detail returns public payment facts, never request fingerprints. Payments do not advance Kitchen status or automatically close a bill.

Two callers collecting a remaining ₹200 are serialized under the existing restaurant transaction lock; the second checks current due and cannot overpay. Sessions/capabilities are rechecked under lock. The bill is locked before financial validation/write. A database trigger independently rejects closed-bill collection and excess due. Same actor/key/canonical amount/method/bill returns existing success; changed payload returns IDEMPOTENCY_CONFLICT. Requests persist with the ledger and have no expiry. A browser keeps an uncertain payment request in per-user/per-bill tab storage and locks changes until retry. Do not receive the money again when checking a pending result.

## Derived financial state

Bill totals aggregate actual child-order grand totals, including their own tax snapshots; no second tax computation or cash rounding. net_paid = collections - refunds. Positive total minus net_paid is amount_due; a negative balance produces refund_due. UNPAID, PARTIALLY_PAID, PAID and REFUND_DUE are backend-derived states, independent of OPEN/CLOSED and Kitchen lifecycle. Zero-total bills are PAID with no fabricated ledger entry.

## Permissions and LAN operation

OWNER/MANAGER/CASHIER receive payments.read/collect. KITCHEN cannot access financial details. Pure DISPATCH sees limited settlement status only and cannot collect; CASHIER+DISPATCH naturally combines capabilities and can open settlement from Dispatch. All operations use the local API/PostgreSQL and work with WAN down while LAN/server/database remain available. A UPI entry records the cashier's observation of receipt; it makes no claim of gateway verification.

## Permanent refund rule and pending work

Customer refunds are always CASH from Counter, including refunds of originally UPI-paid bills. No UPI refunds and no refund controls in Kitchen or Dispatch. Schema allows the future REFUND/CASH shape but rejects refund inserts now. The next milestone must introduce legitimate amendment-derived refund entitlement, authorized/idempotent compensating entries and concurrent refund-limit checks. Past payments remain intact when an amendment changes a bill's effective total; derive new amount_due/refund_due from the revised total and unchanged ledger. No arbitrary refund path exists in this milestone.

## Atomic POS confirmation collections (013)

In addition to standalone Bill collection, Orders orchestrates optional Cash/UPI receipts on its existing transaction connection. Current bill due is quoted before the touch payment step, then recomputed under the shared lock at confirmation. expectedDue must match; received Cash + UPI must be positive and <= due. Zero entries are omitted rather than creating fake payments. Cash/UPI full, partial Cash, partial UPI, split and Pay Later are supported; no money is implied by Pay Later.

Each positive ledger row retains actor/time and an optional confirmation_order_id FK. A unique confirmation order/method index and same-order/bill/actor insert guard protect provenance. Primary duplicate-submission protection is the permanent actor/request confirmation fingerprint, including canonical payment fields. Bill/order/token/ledger commit or roll back together. UI clearly says to record only money already received; UPI has no external verification. Settlement triggers pause persistent payment reminders immediately; partial payment preserves recurrence. Refund posting remains prohibited.
