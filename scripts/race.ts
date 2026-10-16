// Spike test over HTTP against a running server, followed by an invariant check.
// Usage: npm run race -- <buyers> <seats>
import { randomUUID } from "node:crypto";
import { loadAuthSecret, signToken } from "../src/auth.js";
import { createPool } from "../src/db.js";
import { checkInvariants } from "../src/invariants.js";

function positiveInt(value: string | undefined, fallback: number, name: string) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}

const BASE = process.env.API_URL;
if (!BASE) throw new Error("API_URL is not set");
const authSecret = loadAuthSecret();
const buyers = positiveInt(process.argv[2], 2000, "buyers");
const seatCount = positiveInt(process.argv[3], 100, "seats");
const CONCURRENCY = positiveInt(process.env.CONCURRENCY, 200, "CONCURRENCY");
const db = createPool();

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

const adminToken = await signToken(authSecret, "race-admin", "admin");
// A unique name lets us find this exact event in the database below.
const eventName = `Spike Test ${randomUUID()}`;
const event = await post("/events", { name: eventName, priceCents: 12000, seatCount }, {
  authorization: `Bearer ${adminToken}`,
});
if (event.status !== 201) {
  throw new Error(`Could not create event (${event.status}): ${JSON.stringify(event.json)}`);
}
const eventId = event.json.id;

// Without this, pointing DATABASE_URL at the wrong database would make the
// invariant check pass against data this run never touched.
const { rowCount } = await db.query("SELECT 1 FROM events WHERE id = $1 AND name = $2", [eventId, eventName]);
if (!rowCount) {
  throw new Error("DATABASE_URL is not the database the server at API_URL is using");
}

const firstSeat = Number((await (await fetch(`${BASE}/events/${eventId}/seats`)).json()).seats[0].id);

const latencies: number[] = [];
const outcomes: Record<string, number> = {};
const count = (k: string) => (outcomes[k] = (outcomes[k] ?? 0) + 1);

async function buyer(i: number) {
  const pool = Math.random() < 0.7 ? Math.min(20, seatCount) : seatCount; // front row is popular
  const n = 1 + (i % 2);
  const seatIds = Array.from({ length: n }, () => firstSeat + Math.floor(Math.random() * pool));
  const authorization = `Bearer ${await signToken(authSecret, `buyer-${i}`)}`;

  const hold = await post("/holds", { eventId, seatIds }, { authorization });
  latencies.push(hold.ms);
  if (hold.status !== 201) return count(`hold ${hold.status} ${hold.json?.error?.code ?? ""}`.trim());
  count("hold 201");

  const pay = await post(`/holds/${hold.json.id}/checkout`, {}, {
    authorization,
    "idempotency-key": `race-${eventId}-${i}`,
  });
  latencies.push(pay.ms);
  count(`checkout ${pay.status} ${pay.json?.error?.code ?? ""}`.trim());
}

const start = performance.now();
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    // A failed request is part of the result under load, so record it and keep going.
    while (next < buyers) await buyer(next++).catch((err) => count(`client error ${err.cause?.code ?? err.name}`));
  }),
);
const seconds = (performance.now() - start) / 1000;

console.log(`\n${buyers} buyers, ${seatCount} seats, ${CONCURRENCY} in flight, ${seconds.toFixed(1)}s`);
if (latencies.length) {
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]);
  console.log(`${Math.round(latencies.length / seconds)} req/s   p50 ${pct(50)}ms   p95 ${pct(95)}ms   p99 ${pct(99)}ms\n`);
} else {
  console.log("No requests completed\n");
}
console.table(Object.fromEntries(Object.entries(outcomes).sort()));

const { rows } = await db.query(
  `SELECT (SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'sold')::int AS sold_seats,
          count(o.id)::int AS orders,
          coalesce(sum(o.amount_cents), 0)::int AS revenue_cents
   FROM holds h JOIN orders o ON o.hold_id = h.id
   WHERE h.event_id = $1`,
  [eventId],
);
const run = rows[0];
const result = await checkInvariants(db);
await db.end();

console.log("This run:", run);
// Payments that timed out can still be confirmed later by the sweeper, so more
// orders than 201s is fine. Fewer means a buyer was told they paid with no order.
const confirmed = outcomes["checkout 201"] ?? 0;
const missingOrders = run.orders < confirmed;
if (missingOrders) console.error(`MISSING ORDERS: ${confirmed} checkouts succeeded but only ${run.orders} orders exist`);
if (result.ok) {
  console.log(`Invariants across the whole database: all ${result.rulesChecked} hold`);
} else {
  console.error("INVARIANT VIOLATIONS:", result.violations);
}
process.exit(result.ok && !missingOrders ? 0 : 1);
