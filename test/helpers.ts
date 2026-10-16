import { createPool, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/tickets_test";

export async function setupDb(poolSize = 50): Promise<Db> {
  const db = createPool(TEST_DATABASE_URL, poolSize);
  await migrate(db);
  return db;
}

export async function resetDb(db: Db) {
  await db.query("TRUNCATE orders, seats, holds, events RESTART IDENTITY CASCADE");
}

/** Run `fn` for each item at once and collect every outcome, success or failure. */
export async function allSettled<T>(n: number, fn: (i: number) => Promise<T>) {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
  const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<T>> => r.status === "fulfilled").map((r) => r.value);
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
  return { ok, errors };
}
