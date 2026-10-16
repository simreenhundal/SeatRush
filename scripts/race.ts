/**
 * Spike test over HTTP against a running server. Simulates a ticket drop:
 * thousands of buyers fire at once, most fighting over the best seats.
 *
 *   npm start                        # in one terminal
 *   npm run race -- 5000 100         # buyers, seats
 *
 * Each buyer holds 1-2 seats (70% aim at the front row), then checks out.
 * Prints latency percentiles and then verifies the database invariants.
 */
import { createPool } from "../src/db.js";
import { checkInvariants } from "../src/invariants.js";

const BASE = process.env.API_URL ?? "http://localhost:3000";
const buyers = Number(process.argv[2] ?? 2000);
const seatCount = Number(process.argv[3] ?? 100);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 200);

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const start = performance.now();
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json();
  return { status: res.status, json, ms: performance.now() - start };
}

const event = await post("/events", { name: "Spike Test", priceCents: 12000, seatCount });
const eventId = event.json.id;
const firstSeat = Number((await (await fetch(`${BASE}/events/${eventId}/seats`)).json()).seats[0].id);

const latencies: number[] = [];
const outcomes: Record<string, number> = {};
const count = (k: string) => (outcomes[k] = (outcomes[k] ?? 0) + 1);

async function buyer(i: number) {
  const pool = Math.random() < 0.7 ? Math.min(20, seatCount) : seatCount; // front row is popular
  const n = 1 + (i % 2);
  const seatIds = Array.from({ length: n }, () => firstSeat + Math.floor(Math.random() * pool));
  const hold = await post("/holds", { eventId, seatIds }, { "x-user-id": `buyer-${i}` });
  latencies.push(hold.ms);
  if (hold.status !== 201) return count(`hold ${hold.status} ${hold.json?.error?.code ?? ""}`.trim());
  count("hold 201");

  const pay = await post(`/holds/${hold.json.id}/checkout`, {}, {
    "x-user-id": `buyer-${i}`,
    "idempotency-key": `race-${eventId}-${i}`,
  });
  latencies.push(pay.ms);
  count(`checkout ${pay.status} ${pay.json?.error?.code ?? ""}`.trim());
}

// Run buyers with a fixed number in flight at once.
const start = performance.now();
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < buyers) await buyer(next++).catch(() => count("network error"));
  }),
);
const seconds = (performance.now() - start) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]);
console.log(`\n${buyers} buyers, ${seatCount} seats, ${CONCURRENCY} in flight, ${seconds.toFixed(1)}s`);
console.log(`${Math.round(latencies.length / seconds)} req/s   p50 ${pct(50)}ms   p95 ${pct(95)}ms   p99 ${pct(99)}ms\n`);
console.table(Object.fromEntries(Object.entries(outcomes).sort()));

const db = createPool();
const result = await checkInvariants(db);
await db.end();
console.log(result.ok ? "Invariants: all hold" : "INVARIANT VIOLATIONS", result.ok ? "" : result.violations, result.stats);
process.exit(result.ok ? 0 : 1);
