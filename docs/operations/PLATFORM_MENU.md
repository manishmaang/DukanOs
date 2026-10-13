# Enable Swiggy and Zomato menu — one-time SQL

This task prepares files only. **The owner executes production commands; the coding agent must not connect to production.** No application release/build, migration, restart, privilege grant or provider integration is needed. Do not rerun or modify `seed-rudragiri-menu.sql`.

## Expected result and scope

The owner reports 15 active categories, 118 active dishes, 156 active/priced/available Counter variants and 133 menu audit records. `enable-platform-menu.sql` inserts only missing SWIGGY/ZOMATO settings, copying each current Counter numeric price exactly. Availability is true; normal_amount/reduced_amount/serving_unit remain NULL. It does not keep prices synchronized later. Future channel edits use Menu.

From the reported initial state: 312 new channel rows, 118 UPDATED item audit records, 251 total menu audit records. Each variant has three configured/priced/available channels. Existing IDs, Counter rows, portion/display labels, kitchen names, photos, categories, users and financial/history rows remain unchanged. Existing triggers increment each affected item version once per inserted channel row (two per variant from empty platform settings), updating only its version/updated_at. No versions are assigned manually.

One audit per affected dish contains complete before/after public Menu aggregates, including photo metadata, descriptions, labels, all channel settings and Counter visibility. It uses the explicitly selected existing active OWNER with menu.manage. The protected maintenance identity authorizes this local operator action; OWNER username is audit attribution, not password authentication. No user/session is fabricated.

## Transaction, conflicts and privileges

Default dry-run runs every insert/audit and deferred constraint, prints counts, then ROLLBACK. It takes short-lived write locks, so run during a quiet period; five-second lock timeout fails cleanly. Explicit `apply=true` AND `confirm=ENABLE_PLATFORMS_156_312` is required to COMMIT. psql ON_ERROR_STOP and connection closure roll back failures. On uncertain COMMIT, reconcile and rerun: exact matches skip without timestamps, versions or duplicate audits.

Before writing, SQL checks expected database/schema ownership, the unchanged 001–021 migration checksums, existing active OWNER/capability, enabled triggers, three active channels and the stated complete active Counter baseline. It intentionally refuses a changed category/item/variant count, sold-out/inactive Counter baseline or missing Counter price for review. It never reactivates Counter data. Existing platform rows must have equal Counter price, available=true and all three measurements NULL; otherwise the whole operation aborts. Matching partial platform configuration is supported: only missing rows are inserted and only affected items audited.

No temporary tables, temporary functions, permanent objects or DDL are created. PL/pgSQL local variables and transaction-local configuration carry context; **TEMPORARY privilege is not required and must not be granted**. Tests use a non-superuser maintenance schema owner with TEMP revoked from both it and PUBLIC. PostgreSQL table constraints and existing triggers stay enabled. Advisory lock 742019323 and menu table locks serialize application/SQL writers. Exact current schema and narrow baseline are deliberate guards, not automatic compatibility with future migrations.

## 1. Review and transfer (laptop)

Use the reviewed branch `chore/enable-platform-menu` or completed merge. Review both new SQL files and compare SHA256 locally/on EC2. Transfer only these files, never the old seed or old verification file:

```bash
cd /home/manish-pandey/Desktop/DukanOs
git log -1 --oneline
sha256sum scripts/enable-platform-menu.sql scripts/verify-platform-menu.sql
scp -i ~/Downloads/DukanOs_EC2.pem scripts/enable-platform-menu.sql scripts/verify-platform-menu.sql ubuntu@13.233.74.152:/home/ubuntu/
ssh -i ~/Downloads/DukanOs_EC2.pem ubuntu@13.233.74.152
```

On EC2 (performed by the owner):

```bash
sha256sum /home/ubuntu/enable-platform-menu.sql /home/ubuntu/verify-platform-menu.sql
less /home/ubuntu/enable-platform-menu.sql
sudo install -d -o root -g root -m 0700 /var/lib/dukanos-menu-import
sudo install -o root -g root -m 0600 /home/ubuntu/enable-platform-menu.sql /home/ubuntu/verify-platform-menu.sql /var/lib/dukanos-menu-import/
sudo sha256sum /var/lib/dukanos-menu-import/enable-platform-menu.sql /var/lib/dukanos-menu-import/verify-platform-menu.sql
```

The reviewed copies stay outside `/opt/dukanos/current`. No application update/restart is needed. Do not edit migration history, grant TEMP or bypass failed validation.

## 2. Safe dry run using protected maintenance credentials

Run this exact block on EC2. It loads `/etc/dukanos/maintenance.env` without displaying its contents and passes the password only through the child process environment, never command arguments. Do not enable shell tracing. It invokes psql, not DukanOS startup/workers. The connection must target loopback port 5432/database dukanos_prod as the schema-owning maintenance identity.

```bash
platform_mode=dry-run
read -r -p 'Existing OWNER username: ' platform_owner
sudo env -i PATH=/usr/bin:/bin PLATFORM_MODE="$platform_mode" PLATFORM_OWNER="$platform_owner" \
  node --env-file=/etc/dukanos/maintenance.env <<'NODE'
const { spawnSync } = require('node:child_process');
try {
  const u = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
      (u.port && u.port !== '5432') || u.pathname !== '/dukanos_prod' ||
      !u.username || !u.password ||
      [...u.searchParams.keys()].some(k => !['options', 'sslmode'].includes(k)))
    throw new Error();
  const mode = process.env.PLATFORM_MODE;
  if (!['dry-run', 'apply', 'verify'].includes(mode) || !process.env.PLATFORM_OWNER)
    throw new Error();
  const file = mode === 'verify' ? 'verify-platform-menu.sql' : 'enable-platform-menu.sql';
  const args = ['-X', '-v', 'ON_ERROR_STOP=1', '-v', 'expected_database=dukanos_prod',
    '-v', 'target_schema=dukanos', '-v', 'owner_username=' + process.env.PLATFORM_OWNER];
  if (mode === 'apply') args.push('-v', 'apply=true', '-v', 'confirm=ENABLE_PLATFORMS_156_312');
  args.push('-f', '/var/lib/dukanos-menu-import/' + file);
  const result = spawnSync('/usr/bin/psql', args, {
    env: { PATH: '/usr/bin:/bin', PGHOST: u.hostname.replace(/^\[|\]$/g, ''),
      PGPORT: '5432', PGDATABASE: 'dukanos_prod', PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password), PGCONNECT_TIMEOUT: '10',
      PGSSLMODE: u.searchParams.get('sslmode') || 'prefer',
      PGPASSFILE: '/dev/null', PAGER: 'cat' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  process.exitCode = result.status ?? 1;
} catch {
  console.error('Platform menu command refused. Check protected maintenance configuration and mode; no credentials printed.');
  process.exitCode = 1;
}
NODE
```

## 3. Apply, then verify

Review the dry-run output: initially `Platform rows inserted: 312, matching rows skipped: 0, UPDATED item audits: 118`; all three channel counts show 156 within the rehearsed transaction. The final line must say it rolled back. A second dry run will give the same planned changes until committed.

Before apply, confirm a recent verified encrypted recovery point and the established restore procedure. See [existing backup/recovery instructions](MENU_IMPORT.md#3-recovery-point-before-apply); backup scheduling/service actions require the operator's agreed window and are not run by this task. Do not regenerate credentials or backup keys. If the recovery point is missing or invalid, stop.

To apply, change only the first line of the block to `platform_mode=apply` and run the complete block again. It supplies both explicit commit flags. Stop on any error; do not rerun the original menu seed. Then set `platform_mode=verify` and run the complete block for read-only reconciliation. Expected:

- COUNTER, SWIGGY and ZOMATO each have 156 configured, priced and available variants.
- `missing_or_conflicting_platform_records = 0`.
- Initial reported state becomes 133 CREATED + 118 UPDATED = 251 menu audits, attributable to the selected OWNER. Later legitimate Menu actions may change audit totals.
- Read-only detail lists all variant UUIDs, preserved names/labels, three prices and platform availability. No measured fields may be present in platform settings.

Verify application readiness and browse both platform menus in POS:

```bash
curl --fail --silent --show-error https://rudragiri-velvase.duckdns.org/api/health/ready
```

OWNER Menu shows prices across all three columns; Zomato/Swiggy POS remains price-free operational entry as designed. Confirm REGULAR/HALF/FULL on Chole and Butter Paneer Masala and REFILL on EXTRA. No test orders/payments are necessary. No provider API publication or actual Zomato/Swiggy marketplace update occurs.

## Recovery and limitations

A SQL failure rolls back this transaction only. On network loss during commit, use verify/dry-run to discover committed state; a successful repeat is an exact no-op. Do not delete audit records or reset versions. After legitimate later channel price/availability changes this one-time script refuses conflicts; use the application for deliberate audited changes. Normal/Less preparation remains order-wide and unaffected. Production execution and live verification remain owner tasks; local tests do not certify live host configuration.

## Local tests (never production)

```bash
npm run build -w @dukanos/api
NODE_ENV=development SMTP_HOST= node --env-file=.env --test scripts/test-enable-platform-menu.cjs
```

Tests refuse production NODE_ENV/non-loopback source/dukanos_prod; they create and remove only a unique disposable database and non-superuser test role. Current migrations are applied only there. Fixture data is created via MenuService from the review table; the original seed script is neither modified nor executed. Coverage: rollback, simultaneous first applies, repeats, partial matching settings, price/null-price/availability/measurement conflicts, missing Counter/inactive-channel refusal, paise equality, audit equality against the application model, preserved labels/photos/kitchen names, existing Counter rows and a paid order, plus execution without TEMP permission.
