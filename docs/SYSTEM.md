# DukanOS current system

## Purpose and scope

DukanOS will replace paper tokens with one digital restaurant order record shared by counter, kitchen, dispatch, and management. Initial scope is **one restaurant at one location**. Multi-tenant and multi-branch operation are outside current scope.

## Current implementation

The repository contains an npm workspace monorepo, NestJS API, React application, PostgreSQL migrations, shared contracts, and automated checks. Staff authentication, many-to-many RBAC, owner bootstrap/recovery, self-service password changes, delegated password resets, audited staff creation/access editing, and permission-filtered navigation are implemented. Menu categories, items, flexible variants, channel prices/availability, audited administration and operational reads are implemented. Counter order entry with daily tokens and immutable sale snapshots is implemented. Kitchen actions, dispatch actions, reports, payments, printing, and integrations remain unimplemented.

`GET /api/health` checks process liveness; `/api/health/ready` checks database connectivity, not migration readiness. The production API serves the compiled frontend from the same origin. The frontend uses hash routes, session restoration and context refresh on focus/every 30 seconds. Staff creation/access editing requires users.manage; password-reset administration requires users.password.reset and role-specific target checks. All authenticated staff have a Change Password screen. POS displays a visual COUNTER menu with local photos, category buttons, search and portion prices; kitchen and dispatch remain placeholders. The dedicated Menu workspace requires menu.manage; Admin remains staff administration. Menu has category-grouped search and a single dish editor that saves metadata, portions, channel prices, availability and an optional local image reference atomically. Counter visibility diagnostics explain hidden dishes. POS refreshes on entry, focus, menu-change notification and every five seconds while visible. OWNER/MANAGER/CASHIER can mark Counter dishes or individual portions sold out/available in the portion dialog; sold-out cards stay visible for restoration. POS also supports an editable cart, plain kitchen instructions and atomic Counter confirmation into QUEUED with a clear token result. A wider dish dialog selects quantities for multiple portions in one Add action, with independent optional instructions for each portion. Current Order uses the wider POS workspace, groups rows visually by dish and keeps totals/confirmation separate from its scrolling item list. Instruction inputs appear only during editing. POS labels use variant names consistently; availability controls remain secondary.

## Technology and architecture

Node.js (development verified with 24.13.1), NestJS 11, TypeScript, React 19, Vite 7, PostgreSQL 16. One modular monolith and one web application. SQL migrations use node-postgres; no ORM is selected. Menu INR prices use checked PostgreSQL numeric values and decimal strings at API boundaries; order totals use exact BigInt paise arithmetic.

## Deployment and continuity

The owner has not chosen local or cloud hosting; cost matters. Internet outages must not stop ordering or kitchen operations. The baseline design therefore permits running the API, built web assets, and PostgreSQL on one shop server reachable over LAN. No CDN or internet-hosted assets are required. Menu photos are processed locally with Sharp and stored under DUKANOS_DATA_DIR/uploads/menu (default ~/.local/share/dukanos/uploads/menu), outside source/build assets. Backups must include PostgreSQL and this persistent directory. Local operation requires a working LAN, server, database, and power; disconnected browser writes are not supported. A cloud-only deployment cannot meet the internet-outage requirement without additional local execution and synchronization. Cloud backup or reporting replication is future work, not implemented functionality.

Counter confirmation uses only local API/PostgreSQL and locally served assets; KDS remains unimplemented. Installation initially needs internet access to download packages/images.

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

Next proposed milestone: Kitchen queue and audited lifecycle actions using the Orders API. Do not begin automatically. Later phases: Payments, Amendments, Customers, Credit, Reports, Integrations. Menu modifiers remain deferred.

Resolve before relevant feature implementation: production tax configuration, future discount/cash-rounding rules, cancellation/amendment cutoffs once cooking starts, receipt hardware, provider API access, shop hardware and backup budget. Menu prices use INR; currency remains INR. Restaurant timezone defaults to Asia/Kolkata; local environment config supplies timezone and generic exclusive order tax (default zero).

## Terminology

Channel: source of an order and pricing context. Variant: portion of a menu product. Amendment: audited change to an existing order. Credit settlement: receivable repayment, not a new sale. Local continuity: operation without WAN while the LAN and server remain available.

## Version control and delivery

The workspace is initialized as a Git repository. The GitHub remote is `git@github.com:manishmaang/DukanOs.git`. The user has authorized committing and pushing every completed major or minor achievement after relevant checks and documentation updates. Every new module/milestone uses a separate branch created from freshly updated main. Intermediate achievements are pushed to that work branch; completed and verified work is merged back into main with a merge commit and pushed. See AGENTS.md sections 22–23 for the persistent delivery workflow. Never commit local environment secrets or generated/dependency files.

## Multi-role RBAC requirement (2026-09-12)

DukanOS uses multi-role operational staff because one employee may serve as cashier, kitchen worker, and dispatcher during the same shift. OWNER and MANAGER are exclusive privileged roles and cannot be combined with operational roles or each other. Every user must have exactly one privileged role OR one or more operational roles.

Use users/roles/user_roles and roles/permissions/role_permissions. Never put a single role on users. Effective permissions are the distinct union across assigned roles. Authenticated context exposes roles[] and permissions[]. Capability checks govern APIs and visible POS/Kitchen/Dispatch navigation; screen switching does not require logout. Backend validation and PostgreSQL constraints reject invalid assignments with INVALID_ROLE_COMBINATION. Implemented in migration 002 and Auth/Users modules. Initial OWNER gets users.manage; OWNER and MANAGER get users.password.reset with restricted targets. MANAGER has no account-creation or role-editing access. Sessions use local passwords and PostgreSQL-backed cookies, expire in 12 hours, and are revoked on target access or password changes. Owner recovery runs locally with hidden input and an exact active OWNER username; no email/SMS/internet service is involved.

## Menu rules

Category → item → data-driven variants → channel settings. COUNTER, ZOMATO and SWIGGY are configuration rows, with independent prices and availability. Effective sellability requires active category/item/variant/channel, a configured price and channel availability enabled. Prices alone never enable sales. Deactivation preserves configuration. OWNER/MANAGER manage configuration; OWNER/MANAGER/CASHIER have menu.availability.manage for Counter-only operational toggles; KITCHEN reads; DISPATCH receives no menu capability. Menu operations depend only on the restaurant API/PostgreSQL, with no provider calls. Item aggregate versions reject conflicting edits; audit records retain configuration changes. Manual display ordering is removed: admin categories/items show newest created first, while POS categories/items and portions use oldest created first with stable ID tie-breakers. New dish forms start with an editable Standard portion. See [Menu](modules/menu.md).

## API input boundaries

All implemented endpoints have explicit body/query contracts and runtime DTO validation. Unknown fields, malformed identifiers, null booleans, invalid nested inputs and unbounded configuration arrays are rejected. See [API validation audit](API_VALIDATION.md) for the endpoint matrix, transport limits and remaining security work. Media replacement/removal cleans obsolete files after commit; failed staging compensates filesystem writes. Explicit media cleanup supports --dry-run and never runs at startup.

## Orders Core

See [Orders](modules/orders.md) for transaction, idempotency and FIFO read contracts. DRAFT is a local cart; confirmation persists QUEUED, names/prices/tax snapshots, confirmed actor and append-only DRAFT→QUEUED history. UUID identifies orders; date-scoped tokens reset at restaurant midnight via PostgreSQL allocation. No payment is implied or recorded. Queued orders cannot be edited; future lifecycle writes require an audited Orders extension. KITCHEN has orders.read but no creation permission.
