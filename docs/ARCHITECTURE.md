# Architecture

## Repository

- `apps/api`: NestJS entry point, HTTP configuration, health module; Auth/Users modules under `src/modules/<domain>` and shared database infrastructure under `src/database`.
- `apps/web`: one React application, with hash routes for POS, kitchen, dispatch, and administration.
- `packages/shared-types`: compile-time public contracts only; no runtime database models or business logic.
- `database/migrations`: ordered, immutable SQL migrations.
- `scripts/migrate.mjs`: PostgreSQL migration runner.
- `docs/modules`: current module status and intended responsibilities.

## Boundaries

Use a modular monolith. Controllers validate transport input and delegate to application services; domain/application services enforce business rules. Future repositories encapsulate SQL. Each module owns its writes; cross-module operations use explicit application orchestration and a shared transaction connection when atomicity is required. Do not use independent transactions for portions of one financial operation. Avoid introducing a generic repository/event framework before it is needed.

Frontend → API contracts → controllers → application/domain logic → PostgreSQL. Shared types must not depend on backend or frontend code. Authorization must be enforced by the API; route visibility is only UX. Health and login endpoints are explicitly public. AuthModule registers a global session/capability guard; UsersModule owns staff mutation logic. DatabaseModule provides the shared PostgreSQL pool and transaction helper. Session requests load current role/permission unions. Authenticated frontend routes are filtered by capabilities; no customer or financial APIs exist yet.

## HTTP and environment

All HTTP endpoints use `/api`. Global validation rejects unknown properties on authentication and staff DTOs. A global exception filter emits code/message responses and hides internal error details. Startup validates port and PostgreSQL URL. Environment files are ignored, with a committed development-only example. No wildcard CORS is enabled: development uses Vite's proxy, and production serves built static assets from NestJS.

## Deployment

The same application can run locally or on a cloud host. The baseline for required WAN-outage continuity is a single authoritative shop instance. Serve the built frontend and API on port 3000; PostgreSQL is bound to loopback on host port 5433 by default. Development Vite runs on port 5173. LAN access requires appropriate host firewall configuration. Public deployment needs TLS, network hardening, and backup/restore verification before business use. Production session cookies require HTTPS. Docker Compose currently runs the database only.

Do not run local and cloud databases as independent writable authorities. No replication, synchronization, failover, service worker, disconnected browser queue, or background jobs exist. Backups and restore procedures remain a release requirement. Choose cloud vs local based on available shop hardware, electricity, maintenance, and backup cost, not an assumed monthly price.

## Real-time and integration plan

Socket.IO will deliver stable application events after database commit. Reconnecting clients must reload canonical state. Delivery must never be the only durable record; select a transactional outbox if reliable asynchronous integration is required. Current scaffold has no socket server or event bus. Provider-specific adapters will validate and normalize payloads and deduplicate provider order IDs; core Orders must not import provider types.

## Verification references

Runtime compatibility was checked against [NestJS first steps](https://docs.nestjs.com/first-steps) and [Vite guide](https://vite.dev/guide/). Migration serialization follows PostgreSQL [transaction-level advisory lock semantics](https://www.postgresql.org/docs/16/explicit-locking.html).

## Dependency maintenance

The root npm override selects Multer 2.3+ to replace the vulnerable transitive version pinned by NestJS's Express adapter. A fresh lockfile installation applies the override; retain it until the upstream dependency is patched. No file-upload endpoints exist. Dependency versions are recorded in `package-lock.json`.

## Auth and staff dependencies

AuthModule imports UsersModule; both depend on shared DatabaseModule. Users owns staff SQL, access policy and audit writes. Auth owns sessions, hashing helpers, CSRF and capability guards. Lightweight transport metadata and request types are shared between the modules; no circular Nest provider dependency exists. No self-contained token role claims are trusted. See [Auth](modules/auth.md), [Users](modules/users.md), and decisions 004/005.

## Password management boundary

UsersModule exports PasswordManagementService for AuthController's self-service endpoint and owns a separate password-reset controller that does not inherit the users.manage requirement. Administrative resets require users.password.reset plus domain-specific actor/target checks. Local owner recovery invokes this service directly from a CLI, with no public recovery route or network identity provider. The recovery CLI accepts only loopback PostgreSQL URLs; application HTTP workflows use the configured restaurant database as before.
