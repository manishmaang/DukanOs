# DukanOS

Single-location restaurant POS and kitchen system, with **staff authentication and multi-role access management** implemented. Operational ordering, payments, and kitchen workflows remain pending.

## Requirements

Node.js 22.12+ (tested with 24.13.1), npm, and Docker with Compose. PostgreSQL 16 can also be supplied directly via `DATABASE_URL` instead of Docker.

## Development

```sh
cp .env.example .env
npm ci
npm run db:up
npm run db:migrate
npm run dev
```

Wait for the database to become healthy before migration (`docker compose ps`). Open `http://localhost:5173`. From other shop devices, use the server's LAN IP on port 5173. The API uses port 3000; Vite proxies `/api` to it. `.env` is loaded by the API and migration scripts. Restart development processes after changing environment settings.

The example credentials are for local development only. If changing the PostgreSQL user/password/database/port, update `DATABASE_URL` to match. A pre-existing database volume retains its original credentials; changing `.env` does not reset it. `npm run db:down` stops containers and preserves data. Do not delete volumes holding real business records.

## Build and run the compiled application

```sh
npm run build
npm start
```

With PostgreSQL running and `.env` configured, visit `http://localhost:3000`. NestJS serves compiled web assets from `apps/web/dist`, including hash routes such as `/#/kitchen`. Run through the root npm scripts to preserve documented environment paths. No external fonts, scripts, or CDNs are used at runtime. Production process supervision, TLS, backups, and restore drills remain to be completed before real shop use.

## Checks

```sh
npm run check
```

Runs ESLint, workspace type checks, API/role-policy/workspace tests, builds, and formatting verification. `npm run format` applies formatting. HTTP tests mock database readiness; a real DB migration/readiness smoke check is separate:

```sh
npm run db:migrate
npm run db:migrate
curl --fail http://localhost:3000/api/health
curl --fail http://localhost:3000/api/health/ready
```

Liveness does not require DB availability. Readiness checks connectivity only. SQL migrations run atomically under an advisory lock and must not be edited after application. See [database documentation](docs/DATABASE.md).

## Structure and next work

`apps/api` — NestJS; `apps/web` — React POS/kitchen/dispatch/admin routes; `packages/shared-types` — public contracts; `database/migrations` — SQL; `docs` — persistent project context.

Read [AGENTS.md](AGENTS.md), [system state](docs/SYSTEM.md), and the relevant module documents before changing code. Staff authentication, users, and backend RBAC are implemented; next implement menu variants and channel prices. Follow the bootstrap phases rather than implementing all domains simultaneously.

## Internet outages and hosting

Hosting remains undecided. Running the built application and database on a shop server permits LAN access without internet; power and the local network must remain available. Cloud-only hosting needs additional offline execution/synchronization to meet the requirement. The scaffold has no offline order queue or cloud synchronization, and actual order/KDS continuity cannot be verified until those features exist. Hardware, electricity, maintenance and backups determine the eventual cost comparison.

## First owner and staff access

Apply migrations before signing in. No default staff account or password is seeded. Create the first owner once, using stdin rather than command-line passwords:

```sh
python3 -c 'import getpass,json,sys; username=getpass.getpass("Username (hidden): "); name=getpass.getpass("Name (hidden): "); password=getpass.getpass("Password (12–128 characters): "); print(json.dumps(dict(username=username,name=name,password=password)))' | npm run auth:bootstrap
```

Then sign in at the application URL. OWNER can create staff and edit roles/status under Admin. CASHIER/KITCHEN/DISPATCH can be combined freely; OWNER and MANAGER must each stand alone. Effective permissions determine visible workspaces. Access changes require a reason and sign the affected user out across devices. Password recovery/change screens are not yet available.

Production must use `NODE_ENV=production` behind HTTPS so Secure session cookies work; development HTTP is not encrypted. Requests that mutate state must send `X-DukanOS-Request: 1`, including login/logout. The web application does this automatically.

## Database-backed RBAC tests

```sh
npm run test:integration
```

Requires the configured local PostgreSQL connection and permission to create a schema. The suite creates a unique `rbac_test_*` schema, applies migrations twice, tests real HTTP sessions/permissions and concurrent SQL enforcement, then drops only its own schema. It does not modify operational application tables. Normal `npm test` does not require PostgreSQL but its HTTP tests need local socket permission.
