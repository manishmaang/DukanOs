# DukanOS

Single-location restaurant POS and kitchen system, with **staff authentication, multi-role access, menu management, Counter order creation, Kitchen Display System and Dispatch handover** implemented. Payments remain pending.

## MVP checkpoint

The completed MVP is preserved on GitHub as the annotated tag **`v0.1.0-mvp`**, marked on 2026-09-23 at commit `df2d141b11dd8463359dd3509b9cc9415b6c0a8a`. It includes staff authentication/RBAC, menu management and local images, Counter POS ordering, and Kitchen Order/Production views with operational availability and combined portion/dish titles. Dispatch and payments were outside that checkpoint; current implementation status is described below.

To revisit this exact source version on a separate branch, start with a clean working tree:

```sh
git fetch origin --tags
git switch -c restore/mvp v0.1.0-mvp
```

Keep this tag fixed; use new tags for later milestones. It preserves source code, not PostgreSQL records, uploaded images or local `.env` configuration. Returning to a runnable historical environment also requires compatible database/configuration and upload backups; switching Git versions does not undo migrations. These checkpoint instructions were added after the tagged commit.

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

Read [AGENTS.md](AGENTS.md), [system state](docs/SYSTEM.md), and the relevant module documents before changing code. Staff authentication, users, backend RBAC, menu, Counter order creation, Kitchen and Dispatch are implemented; the next proposed milestone is Payments. Do not begin it automatically.

## Internet outages and hosting

Hosting remains undecided. Running the built application and database on a shop server permits LAN access without internet; power and the local network must remain available. Cloud-only hosting needs additional offline execution/synchronization to meet the requirement. Counter ordering and Kitchen use local services only; disconnected-browser writes and cloud synchronization are not implemented. Hardware, electricity, maintenance and backups determine the eventual cost comparison.

## First owner and staff access

Apply migrations before signing in. No default staff account or password is seeded. Create the first owner once, using stdin rather than command-line passwords:

```sh
python3 -c 'import getpass,json,sys; username=getpass.getpass("Username (hidden): "); name=getpass.getpass("Name (hidden): "); password=getpass.getpass("Password (12–128 characters): "); print(json.dumps(dict(username=username,name=name,password=password)))' | npm run auth:bootstrap
```

Then sign in at the application URL. OWNER can create staff and edit roles/status under Admin. CASHIER/KITCHEN/DISPATCH can be combined freely; OWNER and MANAGER must each stand alone. Effective permissions determine visible workspaces. Access changes require a reason and sign the affected user out across devices. All authenticated staff can use Change Password. OWNER and MANAGER have a restricted Staff password resets section in Admin; successful changes sign out all target sessions.

Production must use `NODE_ENV=production` behind HTTPS so Secure session cookies work; development HTTP is not encrypted. Requests that mutate state must send `X-DukanOS-Request: 1`, including login/logout. The web application does this automatically.

## Database-backed RBAC tests

```sh
npm run test:integration
```

Requires the configured local PostgreSQL connection and permission to create a schema. The suites create unique `rbac_test_*`, `password_test_*` and `menu_test_*` schemas, applies migrations twice, tests real HTTP sessions/permissions and concurrent SQL enforcement, then drops only its own schema. It does not modify operational application tables. Normal `npm test` does not require PostgreSQL but its HTTP tests need local socket permission.

## Password changes and local owner recovery

- **Own password:** choose Change Password, enter the current password and the new password twice (12–128 characters). On success, sign in again on every device.
- **Staff reset:** under Admin → Staff password resets, select an eligible account, enter and confirm its new password, and record a reason. OWNER can reset MANAGER/operational staff; MANAGER can reset operational staff only. Self-reset and all OWNER targets are excluded from this workflow. Resetting an inactive account does not activate it.
- **Owner cannot sign in:** on the trusted restaurant server, run:

```sh
npm run db:migrate
npm run auth:reset-owner
```

The command asks for the exact owner username, new password, confirmation, and reason. Password input is hidden and terminal history is disabled. It connects only to a loopback PostgreSQL host (`localhost`, `127.0.0.1`, or `::1`), uses the existing password hasher, revokes all owner sessions and records local-system recovery. No HTTP server, internet, email or SMS is needed. It does not create an owner or activate an inactive account. There are no default credentials.

For noninteractive local tooling, provide JSON `{username,newPassword,confirmPassword,reason}` on stdin from a trusted secret source. Do not put passwords in command-line arguments, shell history, source-controlled files, or an audit reason. The CLI rejects command-line arguments and never echoes supplied values. A failed validation changes nothing. Repeating valid recovery safely updates the same account and records another recovery; it does not duplicate users or roles. Account-specific sign-in throttles are cleared; IP-based login limits are unaffected.

Recovery requires trusted local filesystem and database access. Ordinary staff should not have OS access to the server or its database credentials. For an inactive owner, recovery reports OWNER_INACTIVE and leaves activation unchanged.

`npm run check` and `npm run test:integration` cover password policy, delegated authorization, session revocation, concurrent changes, audit constraints, and local recovery success/failure. Integration suites use unique temporary schemas (`rbac_test_*` / `password_test_*`) and remove their own test data afterward.

## Create or edit a menu dish

1. Apply migrations with `npm run db:migrate`, build/start (or use development mode), and sign in as OWNER or MANAGER. Migration 006 adds optional image metadata/references; migration 005 removes only ordering metadata; existing menu records, prices and availability are retained. Do not reset the database.
2. Open **Menu** in the navigation (`/#/menu`). Click **+ Add Category**, enter **Chinese**, then **Save category**.
3. Click **+ Add Item**, enter **Veg Noodles** and choose Chinese. Rename the default **Standard** portion to **Regular**. Click **+ Add variant** for **Half** and **Full**.
4. Enter prices side-by-side: Regular **80 / 95 / 95**, Half **120 / 140 / 145**, Full **180 / 210 / 215** for Counter / Zomato / Swiggy. Channel headings identify each column. Enter at most two decimal places; leave new cells blank where a portion is not offered.
5. Choose the channels under **Available on**, or use individual portion checkboxes. Click **Save Item** once. The whole dish saves together; a failed save changes nothing.
6. Select Veg Noodles from the category list to edit all its details in the same form, then **Save Changes**. To pause Swiggy only, uncheck Swiggy under Available on and save. Counter remains available. To pause the dish everywhere, turn off **Item active** and save.
7. Use search for a dish, category or portion. New categories and dishes appear first in management; POS uses oldest-created-first ordering so additions and renames leave familiar items in place. There are no manual display-order inputs or API fields.
8. For a single-size product, keep Standard or rename it (for example **1 L**). Remove unsaved portion rows freely; deactivate stored portions to preserve their records. Optional kitchen names and short labels remain under secondary details.

A CASHIER can view the POS menu and change Counter availability, but cannot change prices or menu configuration. KITCHEN retains API read access and no administration. Editing category names/descriptions or activation uses the sidebar's Edit action. Inactive categories hide all their dishes. Saving a price does not silently enable sales. Reactivating a dish restores its saved channel flags; review them before saving.

If another administrator changes the dish, your save is rejected without partial updates. Your draft remains visible; use Reload menu and review current values before retrying. Menu drafts are not stored across sessions. No fake menu data is seeded. Channel configuration still uses explicit migrations; no provider integration exists. Structured modifiers remain deferred; Counter ordering uses free-text kitchen instructions.

See [Menu APIs and rules](docs/modules/menu.md) and [database schema](docs/DATABASE.md). Menu read/write operations use the restaurant server and PostgreSQL only. `npm run check` and `npm run test:integration` cover nested saving, rollback, stable ordering, RBAC and migration preservation using isolated test schemas.

## Menu photos and visual POS

Set optional `DUKANOS_DATA_DIR` to an **absolute persistent path**, writable by the server account (default `~/.local/share/dukanos`). Photos live in `uploads/menu` beneath it. Do not place production uploads inside the repository or a disposable container layer. Apply `npm run db:migrate` before running the updated application.

In Menu, open a dish, select its optional photo near the top, review the preview and Save Changes. JPEG/PNG/WebP up to 5 MiB and 24 megapixels are accepted, normalized into metadata-free WebP within 1024×1024. Replace by choosing a new file; Remove photo takes effect on save. No original file is retained. The same form explains why an item would be hidden from Counter: check category/item/portion activation, Counter price and availability. The existing `soya chap gravy` was saved inactive; turn **Item active** on and save to make its configured Counter portions visible.

POS is fixed to Counter and supports availability controls plus order creation. Use category buttons and search, then tap a photo card for portion prices. Missing photos use a local placeholder. Updates refresh on entry/focus, menu-save notifications and every five seconds while POS is visible. No restart/cache clearing is required, and no internet image service is used.

Run `npm run media:cleanup` with the same `.env` and service account to remove unused images older than 24 hours and retry obsolete-file cleanup. Each manager may stage at most 20 unattached photos. Save attaches the selected stage; abandoned uploads expire through cleanup. Back up **PostgreSQL plus DUKANOS_DATA_DIR/uploads/menu** consistently, preferably with writes paused; restore both. Backup automation and disconnected-browser editing are not implemented.

Optional real-browser regression: set `CHROME_BINARY` to an installed local Chromium/Chrome executable and run `npm run test:menu-browser`. It builds the application, creates a disposable PostgreSQL schema and temporary media/profile directories, blocks external browser requests, exercises the photo/POS workflow, and removes its fixtures. Requires local socket/process and schema-creation permissions. It uses generated test images, not photos attached to your real dishes. Screenshots are written to `/tmp/dukanos-visual-pos-desktop.png` and `/tmp/dukanos-visual-pos-tablet.png`.

## Counter sold-out controls and hardening

Apply migration 007 (`npm run db:migrate`) to grant OWNER/MANAGER/CASHIER the narrow Counter availability permission. In POS, tap a dish: use **Mark all sold out / Make all available**, or change one portion. Sold-out cards remain visible; inactive menu entries do not. These controls change only Counter availability—not menu activation, prices, Zomato or Swiggy. Whole-dish restore enables all active priced Counter portions. Other visible devices refresh in about five seconds plus network time. Concurrent stale availability edits require review/retry; these controls do not create orders.

Preview safe media cleanup with `npm run media:cleanup -- --dry-run`; run without --dry-run to remove confirmed old unreferenced media. Reports distinguish candidates/removals/deferred failures. Cleanup never runs at startup. WebP uses quality 82/effort 4; maximum dimensions and orientation correction are unchanged. Keep backing up both database and uploads.

The [API validation audit](docs/API_VALIDATION.md) documents every current endpoint family, transport/DTO limits and remaining security work. JSON mutations require application/json objects; unused body/query fields, null booleans, malformed IDs/nested inputs and unknown fields are rejected without returning submitted secrets. Local searches remain frontend-only.

## Counter ordering

Apply `npm run db:migrate`, build/start the application, and sign in as CASHIER, MANAGER or OWNER. Open POS, tap a dish, choose an available portion, quantity and optional kitchen instruction, then **Add to Order**. Edit quantities/notes or remove lines in Current Order. **Confirm Order** stores the order as QUEUED and shows its daily token and authoritative total. **New Order** starts the next cart. No payment is collected. Kitchen staff receive the order through the Kitchen workspace.

Prices and sellability are rechecked at confirmation. If a portion was sold out, review the identified line. After a network timeout, use **Retry confirmation**: it reuses the stored request identity and cannot create a second order. Keep that tab open until the result is resolved. Ordinary unsent carts are not persisted. To inspect confirmed data, use authenticated `/api/orders?status=QUEUED`, `/api/orders/:id` or `/api/orders/tokens/YYYY-MM-DD/47`.

Local server environment (restart after changing):

```dotenv
RESTAURANT_TIMEZONE=Asia/Kolkata
ORDER_TAX_RATE=0
ORDER_TAX_LABEL=Tax
```

Tokens reset by local calendar date at midnight. Tax is a configurable exclusive percentage (0–100, up to two fractional digits), default zero, rounded once HALF_UP to paise. No tax-law rate is assumed. Historical configuration and totals are snapshotted. Totals are never rounded to whole rupees. See [Orders](docs/modules/orders.md) for idempotency, schema, immutability and Kitchen contracts.

## Kitchen Display System

Apply `npm run db:migrate` (009 preserves existing orders/menu/users/images), then build and restart the API. Sign in as KITCHEN, OWNER, MANAGER or staff with a combined KITCHEN role. Open **Kitchen**. **Order View** shows queued tokens oldest first with NEXT; **Start Order** accepts only that token. Multiple accepted orders can cook in parallel. **Mark Ready** removes an order from active Kitchen; Dispatch handles READY → COMPLETED handover. Tokens show their business date because daily numbers repeat.

**Production View** shows To start and In preparation separately, with compact dish/portion totals and aggregated instruction quantities. Source tokens remain in the API but are hidden from Production UI. Preparation state belongs to the whole order. Notes remain independent per order line; prices/payment data are absent. Devices refresh automatically about every two seconds plus request time, and refetch after actions or reconnect. A connection failure pauses actions until a successful read. The server, LAN and PostgreSQL must remain available; internet is not required. See [Kitchen](docs/modules/kitchen.md) for endpoints and limits.

Run `npm run check` and `npm run test:integration`. For real Chromium verification, set CHROME_BINARY to your local executable and run `npm run test:kitchen-browser`. The script creates three orders through POS in an isolated schema, verifies production totals/source notes, FIFO, START/READY, independent-device conflicts/recovery and tablet layout, and removes its fixtures. Screenshots: `/tmp/dukanos-kitchen-orders.png`, `/tmp/dukanos-kitchen-production.png`, `/tmp/dukanos-kitchen-tablet.png`. It does not modify restaurant orders.

## Compact Kitchen, late orders and availability

Apply `npm run db:migrate` for migration 010, then build/restart. Order View uses up to three cards per row; Production up to four, two on tablets, one on narrow screens. Empty Production sections remain compact. Matching instructions combine by trimmed/collapsed whitespace; different wording/case stays distinct. Normal quantity appears only alongside exceptions. Order tokens stay visible in Order View.

Set optional `KITCHEN_LATE_THRESHOLD_MINUTES=15` in the server environment (integer 1–1440; restart required). At or above the threshold since queuedAt, both queued and preparing cards show static red LATE styling. Preparation does not reset total age and highlighting does not override FIFO. No flashing/animation is used.

Kitchen → **Availability** opens search and whole-dish/per-portion sold-out/restore controls. A pure KITCHEN user gains only menu.availability.manage, not menu.manage. Changes affect Counter only and use existing version checks/audit. POS updates in its normal five-second refresh window; a sold-out portion already in a draft fails confirmation clearly. Existing confirmed orders remain unchanged.

## Dispatch handover

Apply migration 011 with `npm run db:migrate`, then build/restart the API. Existing READY orders remain intact. Sign in as DISPATCH, OWNER, MANAGER or operational staff whose roles include DISPATCH, then open **Dispatch** (`/#/dispatch`). READY orders appear oldest-ready first with token, READY age, dish/portion quantities and optional notes. After handing food over, press **Handed Over**. The order becomes COMPLETED and leaves the queue. This does not record or require payment; there is no undo.

Set optional `DISPATCH_LATE_THRESHOLD_MINUTES=5` (integer 1–1440; restart required) for static late highlighting based on time since READY. Kitchen READY arrivals and other devices' handovers refresh in about two seconds plus request latency. Conflicts and reconnects refetch authoritative state; unavailable connections hide stale actions. CASHIER/KITCHEN alone cannot complete; combined operational roles switch workspaces without logout.

See [Dispatch](docs/modules/dispatch.md) for APIs, history/concurrency and limitations. Run `npm run check`, `npm run test:integration` and, with local CHROME_BINARY configured, `npm run test:dispatch-browser`. Browser fixtures exercise three POS orders through Kitchen and handover on independent devices, with no external traffic or restaurant-data changes. Screenshots are written to `/tmp/dukanos-dispatch-desktop.png` and `/tmp/dukanos-dispatch-tablet.png`. Existing `test:menu-browser` and `test:kitchen-browser` cover regressions.

## Responsive and touch support

Phone, tablet portrait/landscape and desktop support is a core requirement; see [the permanent UI standard and audit](docs/RESPONSIVE_UI.md). Below 900px, use the Workspace selector. POS shows a persistent **View Order** action opening a touch-friendly cart with **Back to dishes**; landscape tablets keep menu/cart side by side. Menu switches list/editor on narrow screens and shows labelled portion/channel pricing cards instead of a wide table. Keyboard-aware dialogs, large touch targets and long-text wrapping preserve normal operations.

Set CHROME_BINARY to local Chromium and run `npm run test:responsive-browser` for all eight documented sizes and representative touch workflows. Fixtures use temporary PostgreSQL schemas/uploads and block external browser traffic. Screenshots/report are written under `/tmp/dukanos-responsive-*`. Run existing Menu/Kitchen/Dispatch browser suites for regressions. Emulation does not replace physical Android/iOS keyboard and browser testing.
