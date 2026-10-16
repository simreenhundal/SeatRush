import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkout, createEvent, holdSeats } from "../src/booking.js";
import type { Db } from "../src/db.js";
import { checkInvariants } from "../src/invariants.js";
import { FakePaymentProvider } from "../src/payments.js";
import { allSettled, resetDb, setupDb } from "./helpers.js";

// These tests fire many requests at the same rows at the same moment,
// through a real Postgres connection pool, and check nothing breaks.

let db: Db;
let eventId: number;

beforeAll(async () => {
  db = await setupDb(50);
});
afterAll(() => db.end());
beforeEach(async () => {
  await resetDb(db);
  eventId = (await createEvent(db, { name: "Flash Sale", priceCents: 9900, seatCount: 50 })).id;
});

describe("race conditions", () => {
  it("200 buyers, 1 seat: exactly one hold succeeds", async () => {
    const { ok, errors } = await allSettled(200, (i) =>
      holdSeats(db, { eventId, userId: `buyer-${i}`, seatIds: [1] }),
    );
    expect(ok).toHaveLength(1);
    expect(errors).toHaveLength(199);
    expect(errors.every((e) => e.code === "SEATS_UNAVAILABLE")).toBe(true);
  });

  it("overlapping multi-seat holds never deadlock or double-hold", async () => {
    // 150 buyers each grab 2-4 random seats out of the first 10.
    // Without consistent lock ordering, this reliably deadlocks.
    const { ok, errors } = await allSettled(150, (i) => {
      const seats = new Set<number>();
      const want = 2 + (i % 3);
      while (seats.size < want) seats.add(1 + Math.floor(Math.random() * 10));
      return holdSeats(db, { eventId, userId: `buyer-${i}`, seatIds: [...seats] });
    });

    expect(errors.every((e) => e.code === "SEATS_UNAVAILABLE")).toBe(true); // no deadlocks, no 500s
    const heldBySuccessfulHolds = ok.flatMap((h) => h.seatIds);
    expect(new Set(heldBySuccessfulHolds).size).toBe(heldBySuccessfulHolds.length); // no seat twice
    const { rows } = await db.query("SELECT count(*)::int AS n FROM seats WHERE status = 'held'");
    expect(rows[0].n).toBe(heldBySuccessfulHolds.length);
  });

  it("50 simultaneous retries of one checkout charge the card once", async () => {
    const payments = new FakePaymentProvider(() => "success", 20);
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1, 2] });
    const { ok, errors } = await allSettled(50, () =>
      checkout(db, payments, { holdId: hold.id, userId: "ana", idempotencyKey: "same-key-123" }),
    );

    expect(errors).toEqual([]);
    expect(new Set(ok.map((r) => r.order.id)).size).toBe(1); // everyone sees the same order
    expect(payments.chargesMade).toBe(1);
    expect((await checkInvariants(db)).ok).toBe(true);
  });

  it("50 checkouts with different keys for one hold: one order, one charge", async () => {
    const payments = new FakePaymentProvider(() => "success", 20);
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1] });
    const { ok, errors } = await allSettled(50, (i) =>
      checkout(db, payments, { holdId: hold.id, userId: "ana", idempotencyKey: `tab-${i}-key` }),
    );

    expect(errors.every((e) => e.code === "CHECKOUT_IN_PROGRESS")).toBe(true);
    expect(new Set(ok.map((r) => r.order.id)).size).toBe(1);
    expect(payments.chargesMade).toBe(1);
  });
});

describe("flash sale simulation", () => {
  it("500 buyers, 50 seats, flaky payments: invariants hold", async () => {
    // 15% of charges decline and 5% time out after charging.
    const payments = FakePaymentProvider.random({ declineRate: 0.15, timeoutRate: 0.05, latencyMs: 5 });

    await allSettled(500, async (i) => {
      const seatCount = 1 + (i % 3);
      const seatIds = Array.from({ length: seatCount }, () => 1 + Math.floor(Math.random() * 50));
      const hold = await holdSeats(db, { eventId, userId: `buyer-${i}`, seatIds });
      const key = `order-${i}-key`;
      try {
        return await checkout(db, payments, { holdId: hold.id, userId: hold.userId, idempotencyKey: key });
      } catch (err: any) {
        // Timeouts are retried with the same key, like a well-behaved client.
        if (err.code === "PAYMENT_PENDING") {
          return checkout(db, payments, { holdId: hold.id, userId: hold.userId, idempotencyKey: key });
        }
        throw err;
      }
    });

    const result = await checkInvariants(db);
    expect(result.violations).toEqual([]);
    // Every charge the provider made turned into exactly one order.
    expect(result.stats.orders).toBe(payments.chargesMade);
    expect(result.stats.sold_seats).toBeLessThanOrEqual(50);
  });
});
