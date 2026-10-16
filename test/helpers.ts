import { randomBytes } from "node:crypto";
import { signToken, type AuthUser } from "../src/auth.js";
import { createPool, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";

// Generated per run so no signing key lives in the repo.
export const authSecret = new Uint8Array(randomBytes(32));

export function tokenFor(userId: string, role: AuthUser["role"] = "user") {
  return signToken(authSecret, userId, role);
}

export async function setupDb(poolSize = 50): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  // resetDb truncates every table, so refuse to run against anything but a test database.
  if (!new URL(url).pathname.includes("test")) {
    throw new Error("TEST_DATABASE_URL must point to a database whose name contains 'test'");
  }
  const db = createPool(url, poolSize);
  await migrate(db);
  return db;
}

export async function resetDb(db: Db) {
  await db.query("TRUNCATE orders, seats, holds, events RESTART IDENTITY CASCADE");
}

export async function allSettled<T>(n: number, fn: (i: number) => Promise<T>) {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
  const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<T>> => r.status === "fulfilled").map((r) => r.value);
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
  return { ok, errors };
}
