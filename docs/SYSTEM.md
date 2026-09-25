# DukanOS current system

## Purpose and scope

DukanOS will replace paper tokens with one digital restaurant order record shared by counter, kitchen, dispatch, and management. Initial scope is **one restaurant at one location**. Multi-tenant and multi-branch operation are outside current scope.

## Current implementation

The repository contains an npm workspace monorepo, NestJS API, React application, PostgreSQL migrations, shared contracts, and automated checks. Staff authentication, many-to-many RBAC, owner bootstrap/recovery, self-service password changes, delegated password resets, audited staff creation/access editing, and permission-filtered navigation are implemented. Menu categories, items, flexible variants, channel prices/availability, audited administration and operational reads are implemented. Counter order entry with daily tokens and immutable sale snapshots is implemented. Kitchen Order/Production views and audited FIFO START/READY actions are implemented. Dispatch READY → COMPLETED handover is implemented. Bills/Tabs, Dine In/Takeaway service, Cash/UPI partial settlement and atomic payment capture during POS confirmation are implemented. Persistent Dine In payment reminders and Kitchen timers are implemented. Reports, refunds/amendments, printing and integrations remain unimplemented.

`GET /api/health` checks process liveness; `/api/health/ready` checks database connectivity, not migration readiness. The production API serves the compiled frontend from the same origin. The frontend uses hash routes, session restoration and context refresh on focus/every 30 seconds. Staff creation/access editing requires users.manage; password-reset administration requires users.password.reset and role-specific target checks. All authenticated staff have a Change Password screen. POS displays a visual COUNTER menu with local photos, category buttons, search and portion prices; Kitchen provides Order/Production views; Dispatch shows READY orders and audited Handed Over actions. The dedicated Menu workspace requires menu.manage; Admin remains staff administration. Menu has category-grouped search and a single dish editor that saves metadata, portions, channel prices, availability and an optional local image reference atomically. Counter visibility diagnostics explain hidden dishes. POS refreshes on entry, focus, menu-change notification and every five seconds while visible. OWNER/MANAGER/CASHIER/KITCHEN can mark Counter dishes or individual portions sold out/available through POS portion controls or the Kitchen Availability panel; sold-out portions remain visible for restoration. POS also supports an editable cart, plain kitchen instructions and server-priced payment review before atomic Counter confirmation into QUEUED with a clear token result. A wider dish dialog selects quantities for multiple portions in one Add action, with independent optional instructions for each portion. Current Order uses the wider POS workspace, groups rows visually by dish and keeps totals/confirmation separate from its scrolling item list. Instruction inputs appear only during editing. POS labels use variant names consistently; availability controls remain secondary.

## Technology and architecture

Node.js (development verified with 24.13.1), NestJS 11, TypeScript, React 19, Vite 7, PostgreSQL 16. One modular monolith and one web application. SQL migrations use node-postgres; no ORM is selected. Menu INR prices use checked PostgreSQL numeric values and decimal strings at API boundaries; order totals use exact BigInt paise arithmetic.

## Deployment and continuity

The owner has not chosen local or cloud hosting; cost matters. Internet outages must not stop ordering or kitchen operations. The baseline design therefore permits running the API, built web assets, and PostgreSQL on one shop server reachable over LAN. No CDN or internet-hosted assets are required. Menu photos are processed locally with Sharp and stored under DUKANOS_DATA_DIR/uploads/menu (default ~/.local/share/dukanos/uploads/menu), outside source/build assets. Backups must include PostgreSQL and this persistent directory. Local operation requires a working LAN, server, database, and power; disconnected browser writes are not supported. A cloud-only deployment cannot meet the internet-outage requirement without additional local execution and synchronization. Cloud backup or reporting replication is future work, not implemented functionality.

Counter confirmation, KDS and Dispatch use only local API/PostgreSQL and locally served assets. Installation initially needs internet access to download packages/images.

## Domain relationships and intended workflows

Auth and Users control access. Menu defines products, portions, modifiers, and channel prices. Orders own price snapshots, item instructions, amendments, and lifecycle. Payments record tender/refunds; Customers identify optional buyers; Credit owns receivables and settlements. Kitchen projects the operational order queue. Reports derive business outcomes from recorded history. Integrations normalize external payloads before calling Orders.

Counter or provider → normalized order → queued → preparing → ready → completed. Amendments retain previous item revisions and financial adjustments. Credit sale creates receivables; repayment reduces debt without creating another sale.

## Required business rules

- Digital orders are authoritative; print failure cannot lose an order.
- Server-side validation, permissions, transactions, and idempotency protect concurrent devices.
- FIFO queue by default; priority overrides require permission, actor, timestamp, and reason.
- Item-level modifiers and instructions remain traceable through kitchen aggregation.
- Final-item sales reporting preserves original order, payment, refund, and amendment history.
- No floating-point money arithmetic. No silent financial edits.

## Pending work and questions

Next proposed milestone: Order Amendments + Cash Refunds. Do not begin automatically. Later phases: Customers, Credit, Reports, Integrations. Menu modifiers remain deferred.

Resolve before relevant feature implementation: production tax configuration, future discount/cash-rounding rules, cancellation/amendment cutoffs once cooking starts, receipt hardware, provider API access, shop hardware and backup budget. Menu prices use INR; currency remains INR. Restaurant timezone defaults to Asia/Kolkata; local environment config supplies timezone and generic exclusive order tax (default zero).

## Terminology

Channel: source of an order and pricing context. Variant: portion of a menu product. Amendment: audited change to an existing order. Credit settlement: receivable repayment, not a new sale. Local continuity: operation without WAN while the LAN and server remain available.

## Version control and delivery

The MVP source baseline is the fixed annotated GitHub tag `v0.1.0-mvp`, marked on 2026-09-23 at commit `df2d141b11dd8463359dd3509b9cc9415b6c0a8a`. It includes authentication/RBAC, Menu, Counter Orders and Kitchen through the Production title refinement. Never move or overwrite this checkpoint; give later milestones new tags. See [README checkpoint instructions](../README.md#mvp-checkpoint) to create a recovery branch. Git does not preserve live PostgreSQL data, uploads or local environment configuration, and switching versions does not reverse migrations; compatible backups are separate requirements.

The workspace is initialized as a Git repository. The GitHub remote is `git@github.com:manishmaang/DukanOs.git`. The user has authorized committing and pushing every completed major or minor achievement after relevant checks and documentation updates. Every new module/milestone uses a separate branch created from freshly updated main. Intermediate achievements are pushed to that work branch; completed and verified work is merged back into main with a merge commit and pushed. See AGENTS.md sections 22–23 for the persistent delivery workflow. Never commit local environment secrets or generated/dependency files.

## Multi-role RBAC requirement (2026-09-12)

DukanOS uses multi-role operational staff because one employee may serve as cashier, kitchen worker, and dispatcher during the same shift. OWNER and MANAGER are exclusive privileged roles and cannot be combined with operational roles or each other. Every user must have exactly one privileged role OR one or more operational roles.

Use users/roles/user_roles and roles/permissions/role_permissions. Never put a single role on users. Effective permissions are the distinct union across assigned roles. Authenticated context exposes roles[] and permissions[]. Capability checks govern APIs and visible POS/Kitchen/Dispatch navigation; screen switching does not require logout. Backend validation and PostgreSQL constraints reject invalid assignments with INVALID_ROLE_COMBINATION. Implemented in migration 002 and Auth/Users modules. Initial OWNER gets users.manage; OWNER and MANAGER get users.password.reset with restricted targets. MANAGER has no account-creation or role-editing access. Sessions use local passwords and PostgreSQL-backed cookies, expire in 12 hours, and are revoked on target access or password changes. Owner recovery runs locally with hidden input and an exact active OWNER username; no email/SMS/internet service is involved.

## Menu rules

Category → item → data-driven variants → channel settings. COUNTER, ZOMATO and SWIGGY are configuration rows, with independent prices and availability. Effective sellability requires active category/item/variant/channel, a configured price and channel availability enabled. Prices alone never enable sales. Deactivation preserves configuration. OWNER/MANAGER manage configuration; OWNER/MANAGER/CASHIER/KITCHEN have menu.availability.manage for Counter-only operational toggles; DISPATCH receives no menu capability. Menu operations depend only on the restaurant API/PostgreSQL, with no provider calls. Item aggregate versions reject conflicting edits; audit records retain configuration changes. Manual display ordering is removed: admin categories/items show newest created first, while POS categories/items and portions use oldest created first with stable ID tie-breakers. New dish forms start with an editable Standard portion. See [Menu](modules/menu.md).

## API input boundaries

All implemented endpoints have explicit body/query contracts and runtime DTO validation. Unknown fields, malformed identifiers, null booleans, invalid nested inputs and unbounded configuration arrays are rejected. See [API validation audit](API_VALIDATION.md) for the endpoint matrix, transport limits and remaining security work. Media replacement/removal cleans obsolete files after commit; failed staging compensates filesystem writes. Explicit media cleanup supports --dry-run and never runs at startup.

## Orders Core

See [Orders](modules/orders.md) for transaction, idempotency and FIFO read contracts. DRAFT is a local cart; confirmation persists QUEUED, names/prices/tax snapshots, confirmed actor and append-only DRAFT→QUEUED history. UUID identifies orders; date-scoped tokens reset at restaurant midnight via PostgreSQL allocation. Payment is optional: Pay Later records none; selected Cash/UPI receipts commit atomically at the parent Bill. Confirmed sale data cannot be edited; Orders owns the implemented audited Kitchen lifecycle commands. KITCHEN uses dedicated operational reads and has no generic financial order-read or creation permission.

## Kitchen

Order View separates QUEUED/PREPARING, marks the oldest cross-date queued order NEXT and permits FIFO START only; READY leaves active Kitchen. Compact Order/Production grids separate queued/preparing work. Production displays instruction quantity breakdowns without token numbers; source tokens, line quantities and original instructions remain preserved in the API. No financial data appears in Kitchen projections. Preparation status is whole-order, not per item. Two-second local polling plus action/focus/reconnect refetch synchronizes devices; failure hides stale actions. Migration 009 enables audited history-driven START/READY, retaining financial/item immutability and existing data. Migration 010 grants Kitchen Counter availability only. Total order age >= KITCHEN_LATE_THRESHOLD_MINUTES (default 15) gets static LATE styling, without changing FIFO. See [Kitchen](modules/kitchen.md) for contracts, concurrency and limits.

## Dispatch

Dispatch shows READY orders by READY history time then UUID, with token, READY age, snapshot dish/portion quantities and secondary notes. Handed Over uses the Orders service for audited READY→COMPLETED and removes the order from the active queue. Existing dispatch.read/dispatch.complete grants permit OWNER/MANAGER/DISPATCH and operational role unions; CASHIER/KITCHEN alone cannot complete. Migration 011 extends history-driven guards without rewriting records. Unique history provides completion time/actor; no duplicated completed_at field exists. Migration 012 additionally requires zero bill due for Takeaway handover; Dine In and legacy unknown-service rounds may be served unpaid. Two-second local polling and conflict/reconnect refetch follow Kitchen conventions. DISPATCH_LATE_THRESHOLD_MINUTES defaults to 5 and uses READY age. See [Dispatch](modules/dispatch.md).

## Responsive and touch requirement

Every frontend workflow must be practical on phones, portrait/landscape tablets, laptops and touch-only devices from initial design. Read [Responsive UI](RESPONSIVE_UI.md) and AGENTS.md section 24 before changing a screen. The shell uses a compact capability-filtered workspace selector below 900px. POS keeps menu/cart beside each other from 900px upward; smaller screens use a persistent View Order button and a single live modal cart. Menu uses focused list/editor views below 900px and labelled stacked portion pricing below 1200px. Touch targets, long text, keyboard-aware dialogs and actual workflow browser checks are completion requirements. Existing Kitchen/Production/Dispatch responsive grids and all domain semantics are preserved.

## Bills and Payments

A Bill is a commercial tab containing one or more independent Kitchen orders/tokens. New Counter confirmation requires DINE_IN/TAKEAWAY plus optional reference, or an existing open bill. First bill/token creation is atomic. Open Bills in POS supports additional rounds, Cash/UPI partial collections, ledger history and explicit closing after all rounds complete and balance settles. OPEN and PAID are independent: early payment does not close a tab. Totals aggregate child-order grand-total snapshots, with no second tax/rounding policy. Backend-derived due/refund due and actor-scoped idempotent append-only payments protect concurrent devices. Kitchen remains financially unaware; Dispatch sees limited status and gates Takeaway handover only. Legacy orders receive marked unknown-service bills without invented payments. See [Bills](modules/bills.md) and [Payments](modules/payments.md). Future customer refunds are CASH ONLY at Counter; refund posting and confirmed-order amendments remain unimplemented.

## Persistent operational alerts

Unpaid open Dine In bills can retain one recurring payment reminder interval, with persistent snooze. Full settlement pauses it; a new unpaid round on an OPEN bill restarts the saved interval. Kitchen has durable label/order/item timers, preset/custom durations, visible due/overdue state and audited acknowledgement/cancellation. Two-second polling shares state across devices. Known cached schedules keep counting during backend failure, clearly marked offline; reconnection replaces them with authoritative state. Optional local Web Audio adds distinct payment/Kitchen tones, explicit Enable Sound and a browser-local mute preference. Due reminders repeat at most every 60 seconds and timers every 20 seconds, coalesced within the permission-filtered active workspace. No new offline writes, cloud push or guaranteed suspended-browser alarms. See [Operational alerts](modules/alerts.md).
