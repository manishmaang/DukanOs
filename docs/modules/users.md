# Users

## Purpose and current implementation

Staff creation, multi-role assignment, activation/deactivation, optimistic concurrency, and append-only access audit records are implemented. The Admin workspace provides staff creation/access editing to users with users.manage and a separate delegated password-reset section to users with users.password.reset.

## Role model

DukanOS uses multi-role operational staff because one employee may serve as cashier, kitchen worker, and dispatcher during the same shift. OWNER and MANAGER are exclusive privileged roles and cannot be combined with operational roles or each other.

Every user has exactly one privileged role (OWNER or MANAGER) OR a nonempty subset of CASHIER/KITCHEN/DISPATCH. Empty, duplicate, unknown, and mixed assignments are rejected with INVALID_ROLE_COMBINATION. The relation is many-to-many users → user_roles → roles; users has no role column. No role hierarchy or active-role switching exists.

## Initial permission matrix

| Role     | Capabilities                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| CASHIER  | orders.create, orders.read, payments.collect, menu.read, menu.availability.manage                                                                   |
| KITCHEN  | kitchen.read, kitchen.update, menu.read                                                                                                             |
| DISPATCH | dispatch.read, dispatch.complete                                                                                                                    |
| MANAGER  | All operational capabilities plus menu.manage, reports.read, payments.refund, orders.cancel, orders.prioritize, credit.adjust, users.password.reset |
| OWNER    | All MANAGER capabilities plus users.manage                                                                                                          |

Permission grants are explicit rows, not a hard-coded privileged bypass. Capability names for future business modules are seeded contracts; those business actions are not yet implemented. Role/permission administration APIs are not exposed; future matrix changes require reviewed migrations.

## APIs

The following require users.manage:

- `GET /api/users`: staff list including roles, permissions, active status and version; never password hashes.
- `POST /api/users`: username, name, password, roles[]. Creates and audits atomically. Normalized usernames are unique; collisions return USERNAME_TAKEN.
- `PATCH /api/users/:id/access`: roles[], active, expected version, reason. Replaces the complete role set atomically; invalid combinations return INVALID_ROLE_COMBINATION, stale versions USER_VERSION_CONFLICT. Blank reasons are rejected. Target sessions are revoked.

Username: 3–64 ASCII letters/digits/dot/underscore/hyphen, starting alphanumeric; stored lowercase. Names: 1–100 nonblank characters. Passwords: 12–128 characters. Staff cannot assign their own privileges without users.manage. At least one active owner must remain through API access edits (LAST_OWNER_REQUIRED).

## Transactions and integrity

A shared transaction advisory lock serializes staff mutations; actor capabilities are rechecked inside the transaction. Expected versions reject overlapping edits. Membership triggers update/lock the parent user row, also protecting direct SQL writers. Deferred constraints validate the final complete role set at commit, permitting atomic role replacement while rejecting roleless users and incompatible combinations. Each committed membership insert/delete advances version; clients treat it as an opaque concurrency token, not a change count.

Created and access-changed audit entries include actor, target, timestamp, reason and old/new access state. No passwords are recorded. A database trigger rejects audit UPDATE/DELETE. Staff are deactivated, not deleted. The last-active-owner safeguard is application enforced; privileged database administrators can bypass application policies and must use reviewed maintenance procedures.

## Initial owner

`npm run auth:bootstrap` reads JSON {username,name,password} from stdin after compiling the API. It only succeeds when no staff accounts exist, creates OWNER exclusively, and audits with a null system actor. It is not an HTTP endpoint. No default credentials are seeded. See README for safe interactive input.

## Tables / dependencies

users, roles, user_roles, permissions, role_permissions, user_audit. Users depends on shared database access and password hashing; Auth consumes Users. User IDs are stable future audit references. No user events are emitted yet.

## Pending work

Name/profile editing, staff search/pagination, and a configurable permission editor if needed. Ordering and financial APIs are future modules.

## Delegated password reset

`users.password.reset` is granted to OWNER and MANAGER. It is independent of users.manage; managers cannot list the complete staff directory, create users, or edit roles/status through this capability.

- `GET /api/users/password-reset-targets`: returns only eligible targets with id, username, name, roles, active, and version. No hashes, passwords, or permissions are returned.
- `POST /api/users/:id/password-reset`: `{newPassword,version,reason}`; returns 204. A nonblank 1–500 character administrative reason and the current target version are required.

| Actor                         | Allowed targets                                                  |
| ----------------------------- | ---------------------------------------------------------------- |
| OWNER with reset capability   | MANAGER and operational staff, including multi-role combinations |
| MANAGER with reset capability | Operational staff only                                           |
| Operational staff             | None, even if the reset capability is accidentally granted       |

Self-reset is rejected; use Change Password. No OWNER account is eligible for the staff-reset workflow, including another owner; owners use self-service or local recovery. Inactive operational/manager accounts may have passwords reset, but remain inactive.

The backend checks the capability and exact actor/target role rule, including inside the mutation transaction after locks are acquired. It rechecks actor session validity and target version. Permission/session changes or target promotion cannot authorize a stale reset. Forbidden targets return PASSWORD_RESET_FORBIDDEN; stale versions return USER_VERSION_CONFLICT. The UI uses the server-filtered target list, and its visibility is never the authorization boundary.

Password hash replacement, user version increment, all target-session deletion, account throttle cleanup and PASSWORD_RESET audit insertion commit atomically. PASSWORD_CHANGED records the same user as actor/target; PASSWORD_RESET records the administrator and target; OWNER_RECOVERED records a null local-system actor and exact target. All include time/reason. Credential events use only `{passwordChanged:true,sessionsRevoked:true}` as their JSON payload—no password or hash snapshots.

## Menu capabilities

Migration 004 adds menu.read for OWNER, MANAGER, CASHIER and KITCHEN. Existing menu.manage remains granted to OWNER and MANAGER. DISPATCH has neither by default. Multi-role permission unions and current-session checks apply unchanged. Menu administration uses capability guards and rechecks menu.manage inside its transaction; POS reading requires menu.read. Migration 007 adds menu.availability.manage to OWNER, MANAGER and CASHIER only; it permits Counter flags, not price/configuration writes.

## Input hardening

See [API validation audit](../API_VALIDATION.md). Transport bodies/queries are explicitly constrained, implicit scalar conversion is disabled, DTO errors omit submitted values, and parser failures remain client-safe. Staff mutations revalidate the HTTP session after acquiring the staff transaction lock. Existing password hashing, cookie, mutation-header, role-combination and database constraints remain intact.

## Orders Core integration

Migration 008 grants KITCHEN orders.read for the future queue consumer. It does not grant orders.create. Existing OWNER/MANAGER/CASHIER order capabilities remain unchanged.
