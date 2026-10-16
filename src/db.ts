import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL, max = 20): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString, max });
}

/**
 * Every multi-step write goes through here, so a failure halfway through never
 * leaves half-written state behind.
 */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // A connection that can't roll back is unusable; destroy it instead of
      // returning it to the pool. The original error is the one worth reporting.
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
