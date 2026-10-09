import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  readdir,
  readFile,
  mkdir,
  writeFile,
  unlink,
  access,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseService } from '../database/database.service';
import { readConfig } from '../config';

@Injectable()
export class ReleaseReadiness {
  private validUntil = 0;
  private verifying?: Promise<void>;
  readonly root = resolve(__dirname, '../../../..');
  constructor(private readonly db: DatabaseService) {}

  async check(force = false) {
    await this.db.check();
    if (!force && Date.now() < this.validUntil) return;
    if (!this.verifying)
      this.verifying = this.verify()
        .then(() => {
          this.validUntil = Date.now() + 30000;
        })
        .finally(() => {
          this.verifying = undefined;
        });
    await this.verifying;
  }
  private async verify() {
    const config = readConfig();
    const directory = join(this.root, 'database/migrations');
    const files = (await readdir(directory))
      .filter((n) => /^\d+_[a-z0-9_]+\.sql$/.test(n))
      .sort();
    if (!files.length) throw new Error('RELEASE_MIGRATIONS_MISSING');
    const ledger = (
      await this.db.query(
        'SELECT name,checksum FROM schema_migrations ORDER BY name',
      )
    ).rows;
    if (ledger.length !== files.length)
      throw new Error('SCHEMA_VERSION_MISMATCH');
    const objects = new Map<string, Set<string>>();
    for (const [index, name] of files.entries()) {
      const sql = await readFile(join(directory, name), 'utf8');
      if (
        ledger[index]!.name !== name ||
        ledger[index]!.checksum !==
          createHash('sha256').update(sql).digest('hex')
      )
        throw new Error('SCHEMA_CHECKSUM_MISMATCH');
      // Migration identifiers follow this repository's unquoted snake_case
      // convention. Track trigger replacements in migration order.
      for (const m of sql.matchAll(
        /\b(CREATE(?: OR REPLACE)?(?: CONSTRAINT)?|DROP) (TABLE|VIEW|FUNCTION|TRIGGER) ([a-z_][a-z0-9_]*)/gi,
      )) {
        const kind = m[2]!.toUpperCase();
        if (!objects.has(kind)) objects.set(kind, new Set());
        if (m[1]!.toUpperCase() === 'DROP') objects.get(kind)!.delete(m[3]!);
        else objects.get(kind)!.add(m[3]!);
      }
    }
    const actual = (
      await this.db.query(`
      SELECT CASE c.relkind WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END kind,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','v')
      UNION ALL SELECT 'FUNCTION',p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema()
      UNION ALL SELECT 'TRIGGER',t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')`)
    ).rows;
    const present = new Set(actual.map((o) => `${o.kind}:${o.name}`));
    for (const [kind, names] of objects)
      for (const name of names)
        if (!present.has(`${kind}:${name}`))
          throw new Error('SCHEMA_OBJECT_MISSING');
    if (config.production) {
      const unsafe = (
        await this.db
          .query(`SELECT bool_or(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
        OR has_schema_privilege(current_schema(),'CREATE')
        OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind IN ('r','v') AND (pg_has_role(session_user,relowner,'USAGE') OR has_table_privilege(oid,'TRUNCATE,TRIGGER')))
        OR has_table_privilege('schema_migrations','INSERT,UPDATE,DELETE')  ) AS unsafe FROM pg_roles WHERE rolname IN (current_user,session_user)`)
      ).rows[0];
      if (!unsafe || unsafe.unsafe)
        throw new Error('UNSAFE_RUNTIME_DATABASE_ROLE');
      const web = join(this.root, 'apps/web/dist');
      const html = await readFile(join(web, 'index.html'), 'utf8');
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)];
      if (!assets.length) throw new Error('FRONTEND_BUILD_MISSING');
      for (const asset of assets) await access(join(web, asset[1]!));
    }
    const data =
      process.env.DUKANOS_DATA_DIR || join(homedir(), '.local/share/dukanos');
    for (const media of ['menu', 'expenses']) {
      const path = join(data, 'uploads', media);
      await mkdir(path, { recursive: true, mode: 0o700 });
      const probe = join(path, `.readiness-${randomUUID()}`);
      try {
        await writeFile(probe, '', { flag: 'wx', mode: 0o600 });
      } finally {
        await unlink(probe).catch(() => {});
      }
    }
  }
}
