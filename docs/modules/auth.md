# Authentication

## Purpose and current implementation

Local username/password authentication with PostgreSQL-backed opaque sessions. NestJS globally protects controller routes unless explicitly marked public. Authentication works without WAN while the local server/database remain reachable.

## Role and capability model

DukanOS uses multi-role operational staff because one employee may serve as cashier, kitchen worker, and dispatcher during the same shift. OWNER and MANAGER are exclusive privileged roles and cannot be combined with operational roles or each other.

Authenticated context exposes `id`, `username`, `name`, `roles[]`, and `permissions[]`. Effective permissions are the distinct union of all assigned roles. There is no `user.role` or active-role selection. Privileged roles receive operational permissions directly through role_permissions, without operational role assignments. `RequirePermissions(...)` requires every listed capability; class and method requirements are combined. No implicit OWNER bypass exists.

## APIs

- `POST /api/auth/login`: public; username/password; returns current user and sets session cookie.
- `GET /api/auth/me`: current authenticated context from the database.
- `POST /api/auth/logout`: revokes current session and clears cookie (204).
- Health routes remain public. Future controllers are authenticated by default and must declare capabilities for sensitive actions.

## Sessions and security

32-byte cryptographically random tokens; only SHA-256 token hashes are stored. Cookies are HttpOnly, SameSite=Strict, scoped to `/api`, and Secure when NODE_ENV=production. Session lifetime is 12 hours, with no sliding refresh. Production therefore requires HTTPS. Development HTTP is for a trusted local environment; LAN HTTP does not encrypt credentials. Browser storage never receives tokens or passwords.

Roles, permissions, active status, and session expiry are loaded together on every authenticated request. Role/status changes revoke all target sessions; logout revokes only the current session. A login rechecks the locked user version after password verification, preventing a concurrent access change from issuing a stale session.

All non-safe HTTP methods—including login—require `X-DukanOS-Request: 1`. Same-origin requests and disabled cross-origin CORS prevent other websites from supplying this header with cookies. Do not enable permissive credentialed CORS. Authenticated responses have Cache-Control: no-store. Missing/expired sessions return AUTHENTICATION_REQUIRED; insufficient capability returns PERMISSION_DENIED; missing mutation header returns CSRF_CHECK_FAILED.

Passwords use Node's asynchronous scrypt (N=32768, r=8, p=3), a random 16-byte salt and timing-safe comparison. New passwords must have 12–128 characters. Unknown usernames perform equal-cost verification; invalid and inactive accounts use the same INVALID_CREDENTIALS response. No raw passwords or token values are logged. These parameters follow [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Persistent atomic login counters allow 10 attempts per normalized username and 60 per source IP per 15-minute window; successful attempts also count. Limits survive restarts and apply before password hashing. X-Forwarded-For is not trusted; a reverse proxy's address is the source unless a narrowly trusted proxy configuration is introduced. Login counters older than a day and expired sessions are cleaned opportunistically during login.

## Frontend

Sign-in/session restoration, sign-out, and capability-filtered POS/Kitchen/Dispatch/Admin navigation are implemented. A single session permits switching all allowed workspaces without logout. Direct navigation to an unauthorized workspace renders unavailable. Context refreshes on focus and every 30 seconds; backend checks are authoritative between refreshes. Operational workspaces remain placeholders.

## Dependencies / tables

Users module supplies staff context. Shared DatabaseModule owns the connection pool. Tables: users, roles, user_roles, permissions, role_permissions, auth_sessions, login_attempts. No sockets or auth events are emitted.

## Pending work

Password changes/recovery, MFA, session/device management UI, and deployment TLS/proxy configuration. No public registration or cloud identity provider. Add authorization declarations and tests as each business API is implemented.
