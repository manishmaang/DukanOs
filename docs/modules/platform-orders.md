# Manual platform orders V1

## Purpose and boundary

Staff manually transcribe Zomato/Swiggy food orders into DukanOS. The platform remains authoritative for customer charges, discounts, tax and settlement. These are operational-only orders: no Bill, invoice, collection, refund, tax result, zero-priced sale or later automatic billing. No provider API or customer address/phone is collected.

## Model and invariants

Use the existing Orders aggregate and shared date/token allocator. COUNTER requires its Bill and all monetary/tax snapshots. ZOMATO/SWIGGY require no Bill and NULL monetary/tax fields, plus external reference and discount classification. Both application services and migration 020 enforce these distinctions. Original source, reference, lines and preparation snapshots are immutable.

References are trimmed, uppercased ASCII letters/digits/hyphens/underscores, 1–80 characters, starting alphanumeric. Database uniqueness is (source, external_reference), retained permanently even after cancellation. The same reference on different platforms is valid. A duplicate returns PLATFORM_REFERENCE_EXISTS identifying the existing token; search tracking to inspect it. A cancelled mistaken entry cannot reuse its reference or be edited/reopened in V1. Do not invent a suffix to bypass this protection; reference correction/replacement requires a future audited workflow.

NORMAL and optional REDUCED live on each variant/platform channel setting: positive exact decimal quantity up to 100000, at most two decimal places, unit g or ml; Reduced must be smaller than Normal. No default quantities are seeded. Availability uses existing category/item/variant/channel activation and channel available, independently of optional platform price. Missing serving configuration is displayed explicitly and submission rejects it. Counter still requires prices and retains its existing preparation semantics; measured Counter profiles are deferred.

Discount classification NONE/APPLIED/UNKNOWN is the cashier's observation, not verified platform data. Every selected line explicitly carries the profile and reviewed amount/unit. Normal is the UI default. A discount never automatically selects Reduced; even a no-discount order can explicitly select Reduced only to match the actual platform offering. The operator is responsible for that correspondence; DukanOS cannot verify the advertisement. Mixed profiles remain separate lines. Lines are never automatically merged, preserving distinct notes and selections.

## Transactions and history

Creation takes restaurant advisory lock 742019323, rechecks the current session/capability, checks creator/request UUID and normalized SHA256 fingerprint, checks source/reference uniqueness, revalidates activation/availability and reviewed serving size, allocates the token, inserts immutable names/IDs/quantity/note/serving snapshots and DRAFT→QUEUED history, and commits. Price and tax configuration are never used. Stale serving review returns SERVING_PROFILE_CHANGED; missing configuration returns SERVING_PROFILE_REQUIRED; unavailable food returns ITEM_NOT_AVAILABLE. Menu writes share this lock.

The existing Kitchen START/READY and Dispatch completion own QUEUED→PREPARING→READY→COMPLETED. One FIFO spans all sources, sorted queued_at/id. Platform handover has no settlement prerequisite. Counter Takeaway still requires both collection due and refund due zero. Existing financial order reads and amendment mutation endpoints are Counter-only.

Manual cancellation requires platform_orders.cancel and a nonblank reason. QUEUED/PREPARING/READY may cancel; COMPLETED/CANCELLED are terminal. Append-only platform_order_cancellations stores actor/time/reason and same-transaction history drives CANCELLED; attached active timers cancel atomically. Deferred database checks require matching history and resolved timers. No financial revision or ledger record is created. Conflicting lifecycle/cancellation requests serialize and the loser must refresh.

The existing maintenance worker applies PREVIOUS_DAY_ORDER_CLEANUP_TIME (default 05:00) in RESTAURANT_TIMEZONE. Before today's cutoff no cleanup runs; afterward earlier-date unfinished platform orders cancel through the same lock and worker. System cancellations have null actor, PREVIOUS_BUSINESS_DAY_AUTO_CANCEL and captured timezone/cutoff. Current-date and terminal records stay unchanged. Counter still uses its financial cancellation revision; platform orders never do. Local cancellation does not cancel an external provider order.

## APIs and permissions

All endpoints use /api, authenticated sessions, strict DTOs and existing mutation-header requirements.

| Endpoint                                                  | Capability             | Result                                                                                                |
| --------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| GET /platform-orders/menu?source=ZOMATO or SWIGGY         | platform_orders.create | Price-free categories/items/variants, availability and configured profiles                            |
| POST /platform-orders                                     | platform_orders.create | Confirmed operational order; requestId/source/externalReference/discountClassification/lines required |
| GET /platform-orders?search=reference-or-token&after=UUID | platform_orders.read   | Newest-first 50-order pages with nextCursor; all terminal statuses retained                           |
| GET /platform-orders/:id                                  | platform_orders.read   | Snapshotted lines and actor/time/reason status history                                                |
| POST /platform-orders/:id/cancel                          | platform_orders.cancel | Cancelled operational order; body {reason}                                                            |

OWNER/MANAGER/CASHIER receive all three explicit capabilities in migration 020. Pure Kitchen/Dispatch retain only their existing operational reads/actions and gain no platform creation, cancellation or finances. Menu configuration remains menu.manage (OWNER/MANAGER). Multi-role unions and exclusive privileged roles are unchanged.

## POS and responsive behavior

POS has Counter/Zomato/Swiggy source buttons. A nonempty draft/reference or uncertain submission blocks switching until finished/cleared, preventing cross-source reuse. Platform entry retains photo/category/search browsing, portion quantities 0–99 in selection (1–99 in submitted lines), plain instructions up to 500 characters, explicit serving selection and review. It never opens Counter payment review. Success shows the internal token and Sent to Kitchen. The original Counter component remains responsible for Bills, service, money and additional rounds.

Pending platform requests are saved per user/source in sessionStorage before submission. Uncertain failures retain the exact request and disable editing; Retry uses the same idempotency key. Reload can recover it by selecting that platform. Ordinary unsent drafts are memory-only. Tab closure loses recovery storage; search the durable platform reference before re-entry. Source/reference uniqueness is an additional server-side protection.

Track platform orders uses server reads, three-second visible polling, reference/token search, bounded older pages and detail history including handover actor/time. It exposes cancellation to authorized staff and no bill/payment action. Menu refresh uses five-second polling/focus/online; server submission is authoritative.

Phone/portrait tablet use the shared single modal cart; landscape/desktop keep menu and cart side by side. Source badges and serving labels use text, not color alone. Native dialogs scroll within viewport bounds. Browser emulation is not physical Android/iOS keyboard or assistive-technology certification.

## Financial reporting and future integration

Existing financial reports and immutable Daily Reports follow Bills and their effective Counter values; platform orders have no Bill and cannot enter those cohorts. Expenses are independent. Operational source analytics are deferred; existing Reports definitions remain Counter-scoped. Platform progress/history lives in POS and shared Kitchen/Dispatch.

Future official adapters must reconcile external reference, internal order UUID and stable menu/variant mappings without creating a second Kitchen token. Provider payloads, payouts/commission/tax and financial reconciliation require separate design and authorization. Historical manual operational orders must not automatically acquire Bills later.
