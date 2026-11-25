import pg from 'pg';

// numeric -> JS number (costs fit comfortably in a double); int8 -> number for event ids.
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url: string): Db {
  const needsSsl = /sslmode=require|supabase\.(co|com)/i.test(url);
  let connectionString = url;
  if (needsSsl) {
    try {
      const u = new URL(url);
      u.searchParams.delete('sslmode');
      connectionString = u.toString();
    } catch {
      /* let pg report invalid URL */
    }
  }
  return new pg.Pool({
    connectionString,
    max: 12,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
