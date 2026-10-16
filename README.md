# SeatRush

A flash-sale ticketing backend that never oversells, even when thousands of buyers hit the same seats in the same second.

When tickets for a popular show drop, naive systems sell the same seat twice, deadlock, or charge customers for seats they didn't get. SeatRush handles the hard parts: concurrent seat claims, holds that expire, checkout that's safe to retry, and payments that time out mid-flight.

**Stack:** TypeScript · Node.js · Express · PostgreSQL (raw SQL with `pg`) · JWT auth (`jose`) · Zod · Vitest · Supertest · Docker · GitHub Actions

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

**Idempotency.** `Idempotency-Key` is required on checkout and is scoped to the user, so two buyers can't collide or see each other's orders. Retrying with the same key returns the original order or resumes an interrupted payment. The key, prefixed with the hold id, is also passed to the payment provider, so the customer is charged at most once. If the provider times out, the hold stays in `paying` and a retry or the sweeper asks the provider what happened.

**Constraints as the last line of defence.** Unique keys on `orders.hold_id` and `(orders.user_id, orders.idempotency_key)`, and a CHECK that a seat's columns agree with its status, catch any bug the application code misses.

**Invariant checker.** After any load test, `npm run check` verifies no seat was oversold, every charge produced exactly one order, and every order was charged seats × price.

## API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/events` | Admin | `{ name, priceCents, seatCount }` |
| GET | `/events/:id/seats` | Public | Seat map with live status |
| POST | `/holds` | User | `{ eventId, seatIds }`. 409 if any seat is taken |
| POST | `/holds/:id/release` | User | Give seats back. Only the hold's owner can release it |
| POST | `/holds/:id/checkout` | User | Header `Idempotency-Key`. 201 new, 200 replay, 402 declined, 409 in progress, 410 expired, 422 key reused for another hold, 503 payment pending |
| GET | `/health` | Public | Pings the database |

Protected routes take `Authorization: Bearer <token>`, an HS256 JWT signed with `AUTH_SECRET` whose `sub` is the user id and `role` is `user` or `admin`. Missing, forged, expired or unsigned tokens get 401; a user calling an admin route gets 403. Another user's hold returns 404, so hold ids can't be probed.

The API verifies tokens but doesn't issue them; that belongs to a separate login service. `signToken` in `src/auth.ts` creates tokens for tests and the spike test.

Errors share one shape: `{ "error": { "code", "message", "requestId" } }`.

## Running it

All configuration comes from environment variables; nothing has a default that points at a real service.

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | server, bench, race, check | |
| `TEST_DATABASE_URL` | tests | Database name must contain `test`, since tests truncate every table |
| `AUTH_SECRET` | server, race | At least 32 characters; the server refuses to start otherwise |
| `API_URL` | race | Base URL of the running API |
| `POSTGRES_PASSWORD` | Docker Compose | |
| `PAYMENT_DECLINE_RATE`, `PAYMENT_TIMEOUT_RATE`, `PAYMENT_LATENCY_MS` | server | Make the fake payment provider flaky |

Generate the secrets once into `.env`. It's git-ignored, and Docker Compose reads it automatically. Postgres only reads its password the first time it starts, so keep this file; if you lose it, reset the database with `docker compose down -v`.

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 16)
cat > .env <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
AUTH_SECRET=$(openssl rand -hex 32)
DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@localhost:5432/tickets
TEST_DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@localhost:5432/tickets_test
API_URL=http://localhost:3000
EOF
```

Then, in each terminal:

```bash
set -a; source .env; set +a      # load .env into this shell

docker compose up -d db          # Postgres on localhost:5432, creates tickets and tickets_test
npm install
npm test                         # 42 tests, including race and auth tests
npm run bench                    # locking strategy benchmark
npm start                        # API on :3000
npm run race -- 3000 100         # spike test in another terminal, then checks invariants
```

Or run everything in Docker: `docker compose up --build`.

## Project layout

```
migrations/001_init.sql   schema and constraints
src/booking.ts            holds, checkout, sweeper (the core)
src/strategies.ts         the four locking strategies, isolated for comparison
src/invariants.ts         business rules checked after load tests
src/payments.ts           idempotent fake payment provider
src/app.ts                Express routes, auth checks, validation, error handling
src/auth.ts               JWT signing and verification
test/                     unit, API, auth, concurrency and strategy tests
scripts/                  benchmark, HTTP spike test, invariant checker
```

## What's next

- Move hot inventory into Redis with atomic Lua scripts, with Postgres as the source of truth
- Virtual waiting room that admits buyers at a controlled rate with signed tokens
- Connection pooling with PgBouncer, then re-run the spike test to measure the gain
