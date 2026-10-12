# One-time Rudragiri menu SQL import

This is restaurant data maintenance, not an application feature or migration. The owner will run production commands personally. No production data was changed during implementation. No new release, build, restart, migration, credential change or AWS resource is needed to execute the reviewed SQL.

## Reviewed data

[Full menu table](../../data/menu-import/rudragiri-menu-review.md): 15 categories, 118 dishes, 156 variants. Owner corrections on 2026-10-12 resolve all eight ambiguities. CHOLE and BUTTER PANEER MASALA have REGULAR/HALF/FULL; separate Regular dishes are not created. SEV TAMATAR FULL is ₹130. Remaining rows follow HALF/FULL, FULL-only or EXTRA/REFILL rules. SQL stores exact numeric INR values, never floating point. Image corrections override initial readings.

Files:

- `scripts/seed-rudragiri-menu.sql`: self-contained reviewed data, validation, transaction, reconciliation output.
- `scripts/test-rudragiri-menu-import.cjs`: isolated local PostgreSQL test, never a production command.
- `scripts/verify-rudragiri-menu.sql`: read-only post-import checks.

## Safety and audit

Default execution performs the full import and deferred-constraint checks in a transaction, prints planned counts and all 156 prices, then ROLLBACK. It temporarily takes write locks and executes inserts inside the uncommitted transaction; it is a rehearsal, not a lock-free read. Apply requires both `-v apply=true` and `-v confirm=RUDRAGIRI_118_156`. `ON_ERROR_STOP`, PostgreSQL transaction atomicity and psql connection closure roll back any failure. Use `psql -X` to ignore local startup files.

The script checks database name (default `dukanos_prod`), schema (default `dukanos`), schema ownership by the maintenance identity, exact 001–021 migration names/checksums, active Counter channel and an explicit existing active OWNER with `menu.manage`. The controlled maintenance identity substitutes for HTTP authentication; no fake session/user is created. The OWNER username is an audit attribution selected by the operator, not a password authentication mechanism. Credentials belong to the protected maintenance identity.

Application menu auditing is service-created, so direct inserts alone would bypass it. This SQL explicitly inserts the same CREATED category/item aggregate snapshots into append-only `menu_audit`, with the existing OWNER UUID and timestamps. Snapshot equality is tested against the Menu repository. Existing triggers remain enabled, including item-version and deferred variant requirements. The shared advisory lock 742019323 and menu table write locks serialize imports with application menu/order operations. A five-second lock wait fails cleanly; retry during a quiet period rather than disabling locks. Dry run can briefly delay operational writes.

New records are active, with dish-name kitchen defaults and available Counter prices. No photos, platform settings, serving measurements, users, sessions, orders, bills, payments or migrations are written. Existing records are never updated: category/scoped dish/portion names match case-insensitively; exact active Counter price/availability/portion sets skip. Existing descriptions, kitchen names, images and platform settings remain as stored. Inactive or conflicting items/categories abort; missing portions on an existing dish are a conflict, not a partial repair. Unrelated existing dishes remain. Same dish name in different categories is valid. Repeating an unchanged import creates no rows/audits or timestamp/version updates.

## 1. Review and transfer from the laptop

Use the reviewed commit on `feature/bulk-menu-import` (or its completed merge), not an unrelated production release. Review the SQL and table before transfer. No need to deploy application code.

```bash
cd /home/manish-pandey/Desktop/DukanOs
git log -1 --oneline
git diff -- scripts/seed-rudragiri-menu.sql scripts/verify-rudragiri-menu.sql
sha256sum scripts/seed-rudragiri-menu.sql scripts/verify-rudragiri-menu.sql
scp -i ~/Downloads/DukanOs_EC2.pem scripts/seed-rudragiri-menu.sql scripts/verify-rudragiri-menu.sql ubuntu@13.233.74.152:/home/ubuntu/
ssh -i ~/Downloads/DukanOs_EC2.pem ubuntu@13.233.74.152
```

On EC2, compare both SHA256 values with the laptop output and read the actual files. The previous read-only Git check verified deployed HEAD `fdef4f7b41d6a26bb88ef29d30e5e9ec640d70f7`. Recheck without changing Git config:

```bash
release_path=$(readlink -f /opt/dukanos/current)
git -c safe.directory="$release_path" -C "$release_path" rev-parse HEAD
sha256sum /home/ubuntu/seed-rudragiri-menu.sql /home/ubuntu/verify-rudragiri-menu.sql
less /home/ubuntu/seed-rudragiri-menu.sql
sudo install -d -o root -g root -m 0700 /var/lib/dukanos-menu-import
sudo install -o root -g root -m 0600 /home/ubuntu/seed-rudragiri-menu.sql /home/ubuntu/verify-rudragiri-menu.sql /var/lib/dukanos-menu-import/
sudo sha256sum /var/lib/dukanos-menu-import/*.sql
```

This stages reviewed maintenance files outside the running release. Do not change `/opt/dukanos/current`, run migrations or restart the application for this task. Stop if the SQL checks detect a different schema; do not edit migration checksums to bypass them.

## 2. Protected-env psql invocation

The block below reads `/etc/dukanos/maintenance.env` through Node's existing env-file support and invokes psql. Database password exists only in protected configuration/process environment, never command arguments or output. Do not use `set -x`, print the environment, source local development .env, or paste a connection URL into a shell command. Node does not start the application or any workers here.

Set `import_mode=dry-run` first. Enter the exact existing OWNER username (not a secret). Run the same block for each selected mode. Only after reviewing the dry run and taking the recovery point below, set `import_mode=apply` and run it again. Use `import_mode=verify` for read-only checks. No default credentials exist.

```bash
import_mode=dry-run
read -r -p 'Existing OWNER username: ' import_owner
sudo env -i PATH=/usr/bin:/bin IMPORT_MODE="$import_mode" IMPORT_OWNER="$import_owner" \
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
  const mode = process.env.IMPORT_MODE;
  if (!['dry-run', 'apply', 'verify'].includes(mode) || !process.env.IMPORT_OWNER)
    throw new Error();
  const file = mode === 'verify' ? 'verify-rudragiri-menu.sql' : 'seed-rudragiri-menu.sql';
  const args = ['-X', '-v', 'ON_ERROR_STOP=1', '-v', 'expected_database=dukanos_prod',
    '-v', 'target_schema=dukanos', '-v', 'owner_username=' + process.env.IMPORT_OWNER];
  if (mode === 'apply') args.push('-v', 'apply=true', '-v', 'confirm=RUDRAGIRI_118_156');
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
  console.error('Import command refused. Check protected maintenance configuration and mode; no credentials printed.');
  process.exitCode = 1;
}
NODE
```

The explicit SQL schema selection replaces URL search_path options. Unexpected URL options are refused for review, not silently followed. Root can read the env and staged SQL; PostgreSQL permissions come from the maintenance URL identity. The utility requires no environment/dependency installation or production application update. If Node or psql is installed elsewhere, inspect its actual path and adjust the reviewed command.

## 3. Recovery point before apply

Use the already configured backup procedure and an agreed quiet window. The repository backup service temporarily stops and restarts the app; do not start it casually during service. You, the operator, must choose/authorize that window. Inspect the installed service first, because the live setup was not re-audited here:

```bash
sudo systemctl cat dukanos-backup.service
sudo systemctl start dukanos-backup.service
sudo systemctl show dukanos-backup.service -p Result -p ExecMainStatus
sudo cat /var/backups/dukanos/last-success.json
curl --fail --silent --show-error https://rudragiri-velvase.duckdns.org/api/health/ready
```

Require success and a current manifest naming the encrypted artifact and verified off-instance copy. Ensure the offline decryption key and a previously tested restore path are available. A local dump/file alone is not a verified recovery plan. See [backup/recovery guidance](../DEPLOYMENT.md#full-backups-and-isolated-restore). Stop if backup configuration or recovery verification is incomplete; do not regenerate keys/credentials.

## 4. Apply and reconcile

After approving the data and successful dry run/recovery point, set `import_mode=apply` and rerun the exact protected-env block. Expected first import into an empty menu: 15 categories, 118 dishes, 156 variants, 133 menu audit rows. Pre-existing exact matches reduce creation counts; unrelated existing rows make database totals larger. Check every printed expected/actual price. A second identical apply reports zero creation and 118 skipped dishes.

Set `import_mode=verify` and rerun the block for read-only listing/count/audit checks, then:

```bash
curl --fail --silent --show-error https://rudragiri-velvase.duckdns.org/api/health/ready
```

In OWNER Menu, review all categories, Chole/Butter Paneer Masala three portions, Sev Tamatar ₹130 and EXTRA REFILL prices. In Counter POS on tablet/phone, confirm availability and prices; no actual order/payment is required. Existing users and roles should match the pre-import verification output. Existing historical order/payment counts can naturally change while the restaurant is operating; verify imports did not create them using the audit and recovery inventory, not a naive live count comparison.

## Failures and future edits

Any SQL error before COMMIT closes the transaction without partial import. A connection loss at COMMIT can leave success uncertain: rerun dry-run/reconcile; idempotency prevents duplicate records. Do not manually delete new items or roll back the whole database to undo a catalog import after real orders have been placed. Use the existing Menu UI for deliberate audited corrections/deactivation; restore a complete recovery set only under a separate recovery plan that reconciles later transactions.

Do not use this insert-only seed as a price update tool. Future new dishes/prices are maintained in Menu or a separately reviewed data script. Changes to this dataset require review, updated counts/confirmation and regression tests. No restaurant seed belongs in migrations.

## Local verification (never EC2 production)

On the development machine with disposable database creation privileges, build the existing API and run:

```bash
npm run build -w @dukanos/api
NODE_ENV=development SMTP_HOST= node --env-file=.env --test scripts/test-rudragiri-menu-import.cjs
npm run check
```

The test refuses production NODE_ENV, a non-loopback source URL and `dukanos_prod`, creates a uniquely named `dukanos_import_test_*` database, applies current migrations there, then removes only that test database. No restaurant migration is run. Tests cover default rollback, input validation, audit failure rollback, concurrent first runs, repeats, existing conflicts, application audit equality, corrected variants/prices and preservation of populated financial/user/menu records.
