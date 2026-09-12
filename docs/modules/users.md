# Users

## Purpose and current implementation

Staff creation, multi-role assignment, activation/deactivation, optimistic concurrency, and append-only access audit records are implemented. The Admin workspace provides staff creation and access editing to users with users.manage.

## Role model

DukanOS uses multi-role operational staff because one employee may serve as cashier, kitchen worker, and dispatcher during the same shift. OWNER and MANAGER are exclusive privileged roles and cannot be combined with operational roles or each other.

Every user has exactly one privileged role (OWNER or MANAGER) OR a nonempty subset of CASHIER/KITCHEN/DISPATCH. Empty, duplicate, unknown, and mixed assignments are rejected with INVALID_ROLE_COMBINATION. The relation is many-to-many users → user_roles → roles; users has no role column. No role hierarchy or active-role switching exists.

## Initial permission matrix

| Role     | Capabilities                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CASHIER  | orders.create, orders.read, payments.collect                                                                                  |
| KITCHEN  | kitchen.read, kitchen.update                                                                                                  |
| DISPATCH | dispatch.read, dispatch.complete                                                                                              |
| MANAGER  | All operational capabilities plus menu.manage, reports.read, payments.refund, orders.cancel, orders.prioritize, credit.adjust |
| OWNER    | All MANAGER capabilities plus users.manage                                                                                    |

Permission grants are explicit rows, not a hard-coded privileged bypass. Capability names for future business modules are seeded contracts; those business actions are not yet implemented. Role/permission administration APIs are not exposed; future matrix changes require reviewed migrations.

## APIs

All require users.manage:

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

Password change/recovery, name/profile editing, staff search/pagination, and a configurable permission editor if needed. Operational and financial APIs are future modules.
