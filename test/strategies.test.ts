import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { claim, setupBenchTable, type Strategy } from "../src/strategies.js";
import { allSettled, setupDb } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await setupDb(50);
});
afterAll(async () => {
  await db.query("DROP TABLE IF EXISTS bench_seats");
  await db.end();
});

async function winnersFor(strategy: Strategy, buyers = 100) {
  await setupBenchTable(db, 1);
  const { ok } = await allSettled(buyers, (i) => claim(db, strategy, 1, `buyer-${i}`));
  return ok.filter(Boolean).length;
}

describe("locking strategies, 100 buyers on one seat", () => {
  it("naive check-then-write lets several buyers believe they won (the bug)", async () => {
    expect(await winnersFor("naive")).toBeGreaterThan(1);
  });

  it.each(["atomic", "pessimistic", "optimistic"] as const)("%s gives the seat to exactly one buyer", async (s) => {
    expect(await winnersFor(s)).toBe(1);
  });
});
