import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Applies every .sql file in migrations/ once, in name order, each in its own transaction. */
export async function migrate(db: Db, log: (m: string) => void = () => {}) {
  await db.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await db.query('select name from schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(path.join(here, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(here, 'migrations', f), 'utf8');
    const c = await db.connect();
    try {
      await c.query('begin');
      await c.query(sql);
      await c.query('insert into schema_migrations(name) values ($1)', [f]);
      await c.query('commit');
      log(`applied ${f}`);
    } catch (e) {
      await c.query('rollback');
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { loadConfig } = await import('../config.js');
  const { createPool } = await import('./pool.js');
  const db = createPool(loadConfig().databaseUrl);
  await migrate(db, console.log);
  console.log('migrations up to date');
  await db.end();
}
