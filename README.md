# SeatRush

A flash-sale ticketing backend that never oversells, even when thousands of buyers hit the same seats at the same moment.

**TypeScript · Node.js · Express · PostgreSQL · Docker · Vitest**

## Results

Four ways to claim a seat, benchmarked against Postgres:

| Strategy | Oversold (300 buyers, 1 seat) | Claims/sec |
| --- | --- | --- |
| Naive check-then-write | **299** | 14,321 |
| **Atomic conditional update (used)** | 0 | **33,705** |
| Pessimistic row lock | 0 | 14,853 |
| Optimistic versioning | 0 | 15,606 |

Spike test: **3,000 buyers, 100 seats** → 3,117 req/s, p95 178 ms, **zero** oversold seats or double charges.

## How it works

- **No overselling:** checking and claiming a seat happen in one SQL statement, so two buyers can't both win. Multi-seat holds lock rows in a fixed order to avoid deadlocks.
- **Holds expire after 5 minutes**, enforced inside the query itself, so no background job is needed for correctness.
- **Safe checkout:** an `Idempotency-Key` makes retries return the original order, so a timeout never causes a double charge.
- **Auth:** JWT with user and admin roles.

## Run it

Requires Node 20+ and Docker.

```bash
npm install
docker compose up -d db       # Postgres
set -a; source .env; set +a   # load config (create .env first, below)
npm test                      # 42 tests, including race conditions
npm run bench                 # strategy benchmark
npm start                     # API on :3000
npm run race -- 3000 100      # spike test, in a second terminal
```

<details>
<summary>Create <code>.env</code> (one time)</summary>

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

</details>

<details>
<summary>API</summary>

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/events` | Admin |
| GET | `/events/:id/seats` | Public |
| POST | `/holds` | User |
| POST | `/holds/:id/release` | User |
| POST | `/holds/:id/checkout` | User, plus `Idempotency-Key` header |

</details>
