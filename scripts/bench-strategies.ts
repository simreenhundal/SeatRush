// "Oversold" counts buyers who were told they won a seat that ended up
// belonging to someone else. Anything above 0 is a real-world double sale.
import { createPool } from "../src/db.js";
import { claim, setupBenchTable, STRATEGIES, type Strategy } from "../src/strategies.js";

const db = createPool(process.env.DATABASE_URL, 50);

async function run(strategy: Strategy, seats: number, attempts: number) {
  await setupBenchTable(db, seats);
  const start = performance.now();
  const results = await Promise.all(
    Array.from({ length: attempts }, (_, i) => {
      const seat = seats === 1 ? 1 : 1 + Math.floor(Math.random() * seats);
      return claim(db, strategy, seat, `buyer-${i}`);
    }),
  );
  const ms = performance.now() - start;
  const winners = results.filter(Boolean).length;
  const { rows } = await db.query("SELECT count(*)::int AS n FROM bench_seats WHERE owner IS NOT NULL");
  return { ms: Math.round(ms), perSec: Math.round((attempts / ms) * 1000), oversold: winners - rows[0].n };
}

const table: Record<string, unknown>[] = [];
for (const strategy of STRATEGIES) {
  const hot = await run(strategy, 1, 300);
  const spread = await run(strategy, 500, 3000);
  table.push({
    strategy,
    "hot seat: oversold": hot.oversold,
    "hot seat: ms": hot.ms,
    "spread: oversold": spread.oversold,
    "spread: claims/sec": spread.perSec,
  });
}
console.table(table);
await db.query("DROP TABLE IF EXISTS bench_seats");
await db.end();
