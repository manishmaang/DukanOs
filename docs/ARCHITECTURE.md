# Architecture

## Repository

- `apps/api`: NestJS entry point, HTTP configuration, health module; Auth/Users/Menu/Orders/Kitchen modules under `src/modules/<domain>` and shared database infrastructure under `src/database`.
- `apps/web`: one React application, with hash routes for POS, kitchen, dispatch, and administration.
- `packages/shared-types`: compile-time public contracts only; no runtime database models or business logic.
- `database/migrations`: ordered, immutable SQL migrations.
- `scripts/migrate.mjs`: PostgreSQL migration runner.
- `docs/modules`: current module status and intended responsibilities.

## Boundaries

Use a modular monolith. Controllers validate transport input and delegate to application services; domain/application services enforce business rules. Future repositories encapsulate SQL. Each module owns its writes; cross-module operations use explicit application orchestration and a shared transaction connection when atomicity is required. Do not use independent transactions for portions of one financial operation. Avoid introducing a generic repository/event framework before it is needed.

Frontend → API contracts → controllers → application/domain logic → PostgreSQL. Shared types must not depend on backend or frontend code. Authorization must be enforced by the API; route visibility is only UX. Health and login endpoints are explicitly public. AuthModule registers a global session/capability guard; UsersModule owns staff mutation logic. DatabaseModule provides the shared PostgreSQL pool and transaction helper. Session requests load current role/permission unions. Authenticated frontend routes are filtered by capabilities; Orders confirmation/read APIs exist; payment and customer APIs do not.

## HTTP and environment

All HTTP endpoints use `/api`. Global validation rejects unknown properties on authentication, staff and menu DTOs. A global exception filter emits code/message responses and hides internal error details. Startup validates port and PostgreSQL URL. Environment files are ignored, with a committed development-only example. No wildcard CORS is enabled: development uses Vite's proxy, and production serves built static assets from NestJS.

## Deployment

The same application can run locally or on a cloud host. The baseline for required WAN-outage continuity is a single authoritative shop instance. Serve the built frontend and API on port 3000; PostgreSQL is bound to loopback on host port 5433 by default. Development Vite runs on port 5173. LAN access requires appropriate host firewall configuration. Public deployment needs TLS, network hardening, and backup/restore verification before business use. Production session cookies require HTTPS. Docker Compose currently runs the database only.

Do not run local and cloud databases as independent writable authorities. No replication, synchronization, failover, service worker, disconnected browser queue, or background jobs exist. Backups and restore procedures remain a release requirement. Choose cloud vs local based on available shop hardware, electricity, maintenance, and backup cost, not an assumed monthly price.

## Local freshness and integration boundary

Kitchen uses two-second authoritative polling (there was no socket infrastructure), with immediate action/conflict/focus/reconnect refetch and local elapsed timers. Orders and production arrive in one consistent read snapshot; stale responses cannot overwrite newer results. No runtime event bus or socket server exists. A future push transport should publish only after commit and still refetch canonical state on reconnect; select an outbox if durable external delivery becomes required. Provider-specific adapters will validate, normalize and deduplicate provider order IDs; core Orders must not import provider types. See decision 012.

## Verification references

Runtime compatibility was checked against [NestJS first steps](https://docs.nestjs.com/first-steps) and [Vite guide](https://vite.dev/guide/). Migration serialization follows PostgreSQL [transaction-level advisory lock semantics](https://www.postgresql.org/docs/16/explicit-locking.html).

## Dependency maintenance

The root npm override selects Multer 2.3+ to replace the vulnerable transitive version pinned by NestJS's Express adapter. A fresh lockfile installation applies the override; retain it until the upstream dependency is patched. The menu image endpoint uses the bounded Multer memory upload interceptor; only validated JPEG/PNG/WebP content reaches Sharp. Dependency versions are recorded in `package-lock.json`.

## Auth and staff dependencies

AuthModule imports UsersModule; both depend on shared DatabaseModule. Users owns staff SQL, access policy and audit writes. Auth owns sessions, hashing helpers, CSRF and capability guards. Lightweight transport metadata and request types are shared between the modules; no circular Nest provider dependency exists. No self-contained token role claims are trusted. See [Auth](modules/auth.md), [Users](modules/users.md), and decisions 004/005.

## Password management boundary

UsersModule exports PasswordManagementService for AuthController's self-service endpoint and owns a separate password-reset controller that does not inherit the users.manage requirement. Administrative resets require users.password.reset plus domain-specific actor/target checks. Local owner recovery invokes this service directly from a CLI, with no public recovery route or network identity provider. The recovery CLI accepts only loopback PostgreSQL URLs; application HTTP workflows use the configured restaurant database as before.

## Menu boundary

MenuModule owns catalog writes, exact price validation, availability and menu audit. Its repository constructs public aggregates defined in shared-types; persistence rows are not HTTP contracts. The Menu workspace loads one catalog aggregate; POS consumes an active/priced Counter read model including sold-out portions and calls Orders for transactional confirmation. Menu depends on DatabaseModule and shared auth request/permission metadata. All runtime calls remain same-origin/local PostgreSQL. No Zomato/Swiggy client exists: provider mappings belong to future adapters. Modifiers are deferred (see Menu).

## Atomic dish editor

The Menu workspace (`/#/menu`) owns a local controlled draft, category-grouped client-side search, and one save action. POST /api/menu/items accepts nested channel configuration; PUT /api/menu/items/:id validates and saves the complete dish transactionally. This avoids frontend chains of granular writes that can partially succeed. The existing normalized schema, granular APIs, capability guards, transaction lock, aggregate versions and audit remain authoritative. No new state-management or UI framework is introduced. Shared types describe nested input as well as read models; frontend validation is only a convenience.

ReadCatalog selects deterministic database ordering separately for admin and operational reads; clients do not configure positions. Migration 005 removes obsolete ordering columns without rebuilding or reseeding menu records. See decision 008 and Menu for contract details.

## Local menu media and POS freshness

MenuMediaService owns local filesystem operations and Sharp processing inside MenuModule. Migration 006 stores small image metadata and an optional unique item reference; public URLs are same-origin authenticated `/api/menu/images/:key`, never filesystem paths. `DUKANOS_DATA_DIR` must be absolute; the default is `~/.local/share/dukanos`. The generated UUID.webp files live in its `uploads/menu` directory and survive builds/restarts. Production must provision a persistent writable volume/directory for the service account.

Uploads stage a normalized file before metadata insertion. The existing dish POST/PUT attaches or removes a key in the same version-checked, audited transaction as the dish. Menu writes and cleanup share the menu advisory lock. Old files are unlinked only after the replacement/removal commits and only if no item references them. A crash can leave an unreferenced file/metadata row, reclaimed after 24 hours by explicit `npm run media:cleanup`; it cannot make a failed edit delete the currently committed photo. Filesystem failures during obsolete-file cleanup are logged without undoing a successful dish save. An externally deleted file returns 404 and the frontend renders a local placeholder. No distributed file/database transaction or background job is introduced.

Back up PostgreSQL **and** the persistent uploads directory together, preferably during a paused-write maintenance window. Restore both before starting the application. Database-only backups do not contain photo bytes. Backup automation remains future work.

Visual POS is fixed to COUNTER and uses the existing operational read model. It refreshes on mount/focus/visibility return, same-tab menu events, cross-tab BroadcastChannel messages and a visible-tab five-second interval. Request sequencing ignores old responses; failed refreshes replace stale listings with a connection error. Replacement keys create fresh image URLs; responses may be privately cached for one hour. No hard reload, cloud service, socket server or external asset is required. Orders revalidates current menu configuration server-side under the shared menu transaction lock.

## API input contracts and operational availability

The central ValidationPipe remains class-validator/class-transformer based, with whitelist rejection, explicit transformation and no implicit type coercion. InputBoundary requires explicit JSON/multipart contracts, rejects bodies on bodyless routes and queries on non-query routes. Query-bearing actions bind DTOs; route pipes validate identifiers/channel grammar. Parser failures are sanitized by HttpErrorFilter. See [API_VALIDATION.md](API_VALIDATION.md) for the reviewed endpoint matrix.

POS uses a Counter-specific read model including sold-out priced portions, keeping the existing sellable-only channel endpoint unchanged. A narrow availability capability grants cashiers operational flags without opening Menu configuration. Same menu transactions/versions/audit protect edits; simple five-second polling and tab notifications propagate state without new infrastructure. Media cleanup adds immediate failed-staging compensation, dry-run and failure counts; referenced files remain protected by the existing lock/FK strategy.

## Orders boundary

OrdersModule imports MenuModule and shares the confirmation transaction connection with Menu application methods. Orders owns tokens, snapshots, totals and history. BigInt paise implements exact arithmetic; no money library or runtime shared-type logic is introduced. POS retains its visual menu and adds a cart component; pending confirmation identity is kept in per-user tab storage. Tax/timezone are validated server environment settings loaded at startup. KitchenController calls Orders-owned OrderLifecycleService for audited transitions. KitchenService reads operational snapshots and computes production aggregates; it does not write order tables. See decision 011.

## Kitchen boundary

KitchenModule imports OrdersModule for explicit lifecycle commands. It exposes one combined read snapshot for instant Order/Production mode switching and a separate production endpoint. Both use repeatable-read PostgreSQL projections without Menu joins or financial fields. Production aggregation is a pure tested backend function. The existing React router/capability navigation hosts Kitchen.tsx; no new UI or networking dependencies are required. Migration 009 makes history the atomic driver of status while keeping every financial/item field immutable. Confirmation and Kitchen transitions share advisory lock 742019323, then user/session/order locks, to serialize FIFO decisions with queue insertion.
