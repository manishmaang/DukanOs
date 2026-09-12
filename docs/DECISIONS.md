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
