# Architectural decisions

## 001 — Single-location modular monolith

Date: 2026-09-12

### Context

The owner confirmed one restaurant/location. The bootstrap mandates NestJS, React, TypeScript, and PostgreSQL.

### Options considered

Separate services/apps per role; one backend and one web application.

### Decision

Use npm workspaces with `apps/api`, `apps/web`, and `packages/shared-types`. Maintain explicit domain boundaries within one API and role workspaces within one frontend.

### Reason

Keeps setup and deployment small without sacrificing server-side domain ownership.

### Consequences

RBAC is still required on every future sensitive endpoint. Split frontend deployments only if a demonstrated need appears.

## 002 — Local execution baseline for internet continuity

Date: 2026-09-12

### Context

Hosting is undecided and cost-sensitive; ordering and kitchen work must survive internet outages.

### Options considered

Cloud only; shop server; local/cloud writable replicas with synchronization.

### Decision

Design for one authoritative PostgreSQL/API instance, with locally served web assets. A shop server is the baseline continuity path; retain cloud deployment portability. Do not implement bidirectional synchronization in the scaffold.

### Reason

LAN operation avoids depending on WAN for operational requests and does not require distributed order/payment conflict resolution.

### Consequences

Shop LAN, server, and power must remain available. A cloud-only deployment needs additional work to satisfy continuity. Cost comparison, hardware choice, backups, and actual WAN-disconnected order/KDS testing remain pending. This is a design baseline, not a purchase or final hosting decision.

## 003 — Incremental PostgreSQL schema with SQL migrations

Date: 2026-09-12

### Context

The first task establishes reliable scaffolding; business rules are not yet implemented.

### Options considered

Generate the entire domain schema now; incrementally migrate schema with each feature. ORM-managed migrations; explicit SQL.

### Decision

Use PostgreSQL 16, node-postgres, immutable SQL files and a transactional checksum-verified runner. Create infrastructure tables only now; document proposed domain entities separately.

### Reason

Avoids implying that unimplemented financial/domain assumptions are established behavior. SQL exposes constraints and locking directly.

### Consequences

Feature work must implement and test its constraints/transactions. No ORM, money library, or generic repository abstraction has been selected. Runner requires migration SQL that supports transactions.

## 004 — Multi-role operational staff and exclusive privileged roles

Date: 2026-09-12

### Context

One employee can operate POS, kitchen, and dispatch during one shift. The owner explicitly requires privileged roles to be exclusive.

### Options considered

A single user role; unrestricted multiple roles; categorized, constrained many-to-many RBAC.

### Decision

Use users/roles/user_roles with permission unions. OWNER and MANAGER are exclusive PRIVILEGED roles. CASHIER, KITCHEN and DISPATCH are combinable OPERATIONAL roles. Reject empty or mixed role sets in domain validation and deferred database constraints. Serialize membership changes on the user row.

### Reason

Matches staff responsibilities while preventing accidental privilege combinations.

### Consequences

All authenticated contexts expose roles and permissions arrays. Capability-based guards are authoritative; frontend workspaces follow the same permissions. Privileged roles receive capabilities explicitly, not by assignment of operational roles.

## 005 — Local password authentication with server-side sessions

Date: 2026-09-12

### Context

Authentication must work against the local server without internet. Revoking staff access must affect existing sessions.

### Options considered

Cloud identity; self-contained JWT roles; opaque PostgreSQL-backed sessions.

### Decision

Use normalized usernames and scrypt-hashed passwords with random opaque session cookies. Store only token hashes; resolve current roles and distinct permissions from PostgreSQL on every authenticated request. Use HttpOnly, SameSite=Strict cookies and require a custom request header for all mutations. Production cookies require HTTPS. Initial owner creation is a local CLI operation, not public registration.

### Reason

No cloud dependency and no stale role claims in long-lived tokens.

### Consequences

PostgreSQL is required for authentication. Sessions expire after 12 hours; logout revokes the current token, and staff access changes revoke all target sessions. Reverse proxy/TLS remains deployment configuration. Local password recovery is implemented by decision 006; MFA remains future work.

## 006 — Delegated password reset and local owner recovery

Date: 2026-09-12

### Context

Staff require self-service password changes and restricted owner/manager resets. Owner recovery must work without email, SMS or internet.

### Options considered

Reuse broad users.manage for managers; use a separate capability with target-role policy. Public recovery endpoint; explicit local operator command.

### Decision

Grant users.password.reset to OWNER and MANAGER, enforce target-role restrictions in the domain transaction, and expose a filtered reset-target API. Owners reset managers/operational staff; managers reset operational staff only. All OWNER accounts are excluded from staff reset. Authenticated staff use current-password verification for self-change. A loopback-only CLI recovers an exact active OWNER account with hidden input, a reason and system-attributed audit.

### Reason

Allows delegated password support without expanding role-management privileges and preserves independent owner control. Local recovery depends on trusted OS/database access, not an unavailable external service.

### Consequences

All target sessions are revoked on a successful password mutation. Recovery preserves roles and activation; inactive owners require a separately authorized activation procedure. Repeated recovery is safe but intentionally records each successful recovery and increments version. Anyone with local application/database administration access can perform recovery; filesystem/database access must therefore remain restricted to trusted operators. No email/SMS, MFA, default credentials or public recovery tokens are introduced.

## 007 — Menu aggregate, exact prices and persistent availability

Date: 2026-09-12

### Context

One restaurant needs arbitrary portions, different channel prices, quick disable controls and concurrent administrative editing.

### Options considered

Fixed portion enums and item prices; normalized variants/channels. Rounded numeric typmod; numeric with explicit scale checks. Inventory/scheduled availability; simple persistent flags. Full modifier selection/pricing; deferred modifier definition model.

### Decision

Use data-driven variants and sales channels, one checked numeric price and separate availability flag per variant/channel, and category/item/variant activation. Item aggregate versions cover child edits; serialize menu API writes using a transaction advisory lock and preserve audit snapshots. Operational reads return only sellable variants. Defer modifiers with a documented future group/option/assignment model.

### Reason

Meets the current menu needs while preventing silent price rounding and stale overwrites. Modifier selection, exclusions and pricing need order semantics that are outside this milestone.

### Consequences

An unpriced variant is not sellable; saving a price does not enable it. All variants of an item must be disabled on a channel to hide that item there. No inventory, time windows, provider integration or order writes exist. Future orders must store sold names/prices independently. The catalog and its audit snapshots are sized for a small single-location menu; pagination and finer write locking may be introduced if measured demand requires them.

## 008 — One transactional dish save and automatic menu ordering

Date: 2026-09-19

### Context

Manual testing found that separate item/variant/price/availability forms and numeric display-order inputs made ordinary dish maintenance cumbersome. Existing menu data must remain intact.

### Options considered

Coordinate several granular requests from the browser; add aggregate writes within the existing Menu service. Hide unused ordering fields; remove the ordering metadata with a new migration. Use name sorting; use creation order with stable tie-breakers.

### Decision

Keep the normalized domain and existing granular APIs, extend item creation with nested channel settings and add a full-dish PUT. Validate the whole configuration, then save all changes and audit in one existing transaction. Retain stored variant/channel identities; missing existing records are rejected and obsolete portions are deactivated. The UI uses one dish form with an editable Standard initial portion, channel-wide and per-portion availability, and one Save action.

Remove sort_order from all menu configuration tables and public contracts using migration 005, leaving records and audit history intact. Admin categories/items use newest creation first; POS categories/items use oldest creation first. Stable ID tie-breakers handle equal timestamps. Variants use insertion time then ID; channels use creation time then code.

### Reason

The owner can maintain a whole dish without understanding normalized tables. Server transactions guarantee that a failed nested save cannot leave a partially changed dish. Creation order makes additions easy to find in management while preserving the cashier's familiar layout after additions and renames.

### Consequences

Old API clients that send ordering fields must be updated. Deployment applies migration 005 together with the new API/frontend. Old audit snapshots retain removed fields as historical evidence. Existing same-timestamp records use stable ID order, so the migration may change their previous manual layout once. No reorder UI exists. Full-dish requests include stored variants/channel settings; saves use a captured version and require reload after conflicts. No order, payment or kitchen workflow is introduced.

## 009 — Local menu photos with staged attachment

Date: 2026-09-21.

### Context

Visual POS must work during internet outages and preserve the existing single-save dish workflow. PostgreSQL and the filesystem cannot commit atomically.

### Options considered

External object hosting; binary database storage; immediate image attachment; staged local files with transactional reference attachment.

### Decision

Use configurable persistent local storage and Sharp-normalized UUID WebP files, a small metadata table and nullable item reference. Stage before the full-dish save; attach through the existing version/audit transaction. Reclaim unreferenced old assets under the menu lock with an explicit maintenance command. Return same-origin authenticated URLs and change the key on replacement.

### Reason

This keeps runtime fully local, avoids large database binaries and preserves atomic menu editing without a generic media platform or distributed transaction.

### Consequences

A crash may leave harmless unreferenced files until cleanup. Media must be backed up alongside the database. A missing physical file produces a placeholder; application restarts/builds retain files. POS refresh uses lightweight notifications and 15-second visible-tab polling; order-time validation is still future work.

## 010 — Separate Counter operations from menu configuration

Date: 2026-09-21.

### Context

Cashiers need quick sold-out controls without administrative access or changes to other channels. The sellable-only API hides items they must restore.

### Options considered

Grant menu.manage; toggle item.active; add a narrow Counter availability capability and a Counter read model retaining sold-out portions.

### Decision

Grant menu.availability.manage to OWNER/MANAGER/CASHIER. Reuse existing channel flags, aggregate versions and audit in a Counter-only mutation. Keep the default operational channel read sellable-only and provide /menu/counter for active priced portions including sold-out state. Refresh visible POS clients every five seconds with immediate local/tab notification.

### Reason and consequences

Configuration, prices and other channels retain their authorization boundary. Sold-out cards can be restored in place without a redesign. Whole-dish restoration enables all active priced Counter portions; precise partial availability uses individual controls. No automatic daily reset or instantaneous cross-device delivery is promised. Kitchen workflows remain deferred.
