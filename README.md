# SeatRush

A flash-sale ticketing backend that never oversells, even when thousands of buyers hit the same seats in the same second.

When tickets for a popular show drop, naive systems sell the same seat twice, deadlock, or charge customers for seats they didn't get. SeatRush handles the hard parts: concurrent seat claims, holds that expire, checkout that's safe to retry, and payments that time out mid-flight.

**Stack:** TypeScript · Node.js · Express · PostgreSQL (raw SQL with `pg`) · Zod · Vitest · Supertest · k6 · Docker · GitHub Actions

## Results

Benchmark of four seat-claiming strategies against Postgres 16 (`npm run bench`):

| Strategy | Hot seat (300 buyers, 1 seat): oversold | Spread (3,000 claims, 500 seats): oversold | Claims/sec |
| --- | --- | --- | --- |
| Naive check-then-write | **299** | **2,500** | 2,807 |
| Atomic conditional UPDATE (used) | 0 | 0 | **8,498** |
| Pessimistic `SELECT ... FOR UPDATE` | 0 | 0 | 3,333 |
| Optimistic version column | 0 | 0 | 3,525 |

- The naive approach told all 300 buyers they won one seat.
- Without consistent lock ordering, 150 overlapping multi-seat holds produced **85 deadlocks** across 3 runs. With ordering: 0.
- HTTP spike test (`npm run race -- 3000 100`): 3,000 buyers, 100 seats, 10% payment declines, 200 requests in flight. **576 req/s, p95 650 ms, 0 invariant violations.**

Numbers are from a single local machine and will vary on yours.

## How it works

```
POST /holds ──► atomic seat claim ──► hold (5 min) ──► POST /holds/:id/checkout ──► order
                     │                    │                     │
             all-or-nothing,       expiry enforced       idempotent, 3 phases,
             ordered locks         in the query          provider called with no locks held
```

**Overselling.** The check ("is it free?") and the claim are one SQL statement, so two buyers can't both pass the check. Multi-seat holds lock rows in id order so overlapping requests queue instead of deadlocking.

**Expiry.** A seat is claimable if it's free or its hold has expired, evaluated inside the claim query. Correctness never depends on a background job running on time. The sweeper only tidies up.

**Checkout state machine.** `active → paying → confirmed`, or `active → released | expired`. A declined payment returns the hold to `active` so the buyer can retry.

**Idempotency.** `Idempotency-Key` is required on checkout. Retrying with the same key returns the original order or resumes an interrupted payment. The key is also passed to the payment provider, so the customer is charged at most once. If the provider times out, the hold stays in `paying` and a retry or the sweeper asks the provider what happened.

**Constraints as the last line of defence.** Unique keys on `orders.hold_id` and `orders.idempotency_key`, and a CHECK that a seat's columns agree with its status, catch any bug the application code misses.

**Invariant checker.** After any load test, `npm run check` verifies no seat was oversold, every charge produced exactly one order, and every order was charged seats × price.

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/events` | `{ name, priceCents, seatCount }` |
| GET | `/events/:id/seats` | Seat map with live status |
| POST | `/holds` | `{ eventId, seatIds }`, header `X-User-Id`. 409 if any seat is taken |
| POST | `/holds/:id/release` | Give seats back |
| POST | `/holds/:id/checkout` | Headers `X-User-Id`, `Idempotency-Key`. 201 new, 200 replay, 402 declined, 409 in progress, 410 expired, 503 payment pending |
| GET | `/health` | Pings the database |

Errors share one shape: `{ "error": { "code", "message", "requestId" } }`.

`X-User-Id` stands in for real authentication to keep the focus on concurrency.

## Running it

```bash
docker compose up -d db          # Postgres on :5432 (creates tickets and tickets_test)
npm install
npm test                         # 32 tests, including the race tests
npm run bench                    # strategy benchmark (needs DATABASE_URL)

export DATABASE_URL=postgres://postgres:postgres@localhost:5432/tickets
npm start                        # API on :3000
npm run race -- 3000 100         # spike test in another terminal, then checks invariants
```

Or run everything in Docker: `docker compose up --build`.

Make the fake payment provider flaky with `PAYMENT_DECLINE_RATE`, `PAYMENT_TIMEOUT_RATE` and `PAYMENT_LATENCY_MS`.

## Project layout

```
migrations/001_init.sql   schema and constraints
src/booking.ts            holds, checkout, sweeper (the core)
src/strategies.ts         the four locking strategies, isolated for comparison
src/invariants.ts         business rules checked after load tests
src/payments.ts           idempotent fake payment provider
src/app.ts                Express routes, validation, error handling
test/                     unit, API, concurrency and strategy tests
scripts/                  benchmark, HTTP spike test, k6 script, invariant checker
```

## What's next

- Move hot inventory into Redis with atomic Lua scripts, with Postgres as the source of truth
- Virtual waiting room that admits buyers at a controlled rate with signed tokens
- Real authentication in place of `X-User-Id`
- Connection pooling with PgBouncer, then re-run the spike test to measure the gain
