import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkout, createEvent, holdSeats, listSeats, releaseHold, sweep } from "../src/booking.js";
import type { Db } from "../src/db.js";
import { checkInvariants } from "../src/invariants.js";
import { FakePaymentProvider } from "../src/payments.js";
import { resetDb, setupDb } from "./helpers.js";

let db: Db;
let eventId: number;

beforeAll(async () => {
  db = await setupDb();
});
afterAll(() => db.end());
beforeEach(async () => {
  await resetDb(db);
  eventId = (await createEvent(db, { name: "Test Show", priceCents: 5000, seatCount: 40 })).id;
});

async function statusOf(seatId: number) {
  return (await listSeats(db, eventId)).find((s) => s.id === seatId)!.status;
}

function scripted(...outcomes: ("success" | "decline" | "timeout")[]) {
  return new FakePaymentProvider(() => outcomes.shift() ?? "success");
}

describe("holds", () => {
  it("creates seats labelled in rows of 20", async () => {
    const seats = await listSeats(db, eventId);
    expect(seats).toHaveLength(40);
    expect(seats[0].label).toBe("A1");
    expect(seats[20].label).toBe("B1");
  });

  it("holds the requested seats", async () => {
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [3, 1, 2] });
    expect(hold.seatIds).toEqual([1, 2, 3]);
    expect(await statusOf(1)).toBe("held");
  });

  it("is all or nothing when any seat is taken", async () => {
    await holdSeats(db, { eventId, userId: "ana", seatIds: [1, 2] });
    await expect(holdSeats(db, { eventId, userId: "ben", seatIds: [2, 3] })).rejects.toMatchObject({
      code: "SEATS_UNAVAILABLE",
    });
    // Seat 3 was free, but the failed hold must not keep it.
    expect(await statusOf(3)).toBe("available");
  });

  it("rejects seats from a different event", async () => {
    const other = await createEvent(db, { name: "Other", priceCents: 100, seatCount: 1 });
    const otherSeat = (await listSeats(db, other.id))[0].id;
    await expect(holdSeats(db, { eventId, userId: "ana", seatIds: [otherSeat] })).rejects.toMatchObject({
      code: "SEATS_UNAVAILABLE",
    });
  });

  it("rejects empty and oversized holds", async () => {
    await expect(holdSeats(db, { eventId, userId: "ana", seatIds: [] })).rejects.toMatchObject({ status: 400 });
    const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    await expect(holdSeats(db, { eventId, userId: "ana", seatIds: nine })).rejects.toMatchObject({ status: 400 });
  });

  it("lets another buyer take seats once a hold expires, without waiting for the sweeper", async () => {
    await holdSeats(db, { eventId, userId: "ana", seatIds: [1], holdSeconds: -1 });
    expect(await statusOf(1)).toBe("available");
    const hold = await holdSeats(db, { eventId, userId: "ben", seatIds: [1] });
    expect(hold.userId).toBe("ben");
  });

  it("frees seats when a hold is released", async () => {
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1, 2] });
    await releaseHold(db, hold.id, "ana");
    expect(await statusOf(1)).toBe("available");
    await expect(releaseHold(db, hold.id, "ana")).rejects.toMatchObject({ code: "HOLD_NOT_ACTIVE" });
  });

  it("hides other users' holds", async () => {
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1] });
    await expect(releaseHold(db, hold.id, "ben")).rejects.toMatchObject({ status: 404 });
  });
});

describe("checkout", () => {
  it("charges seats x price and marks seats sold", async () => {
    const payments = scripted();
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1, 2] });
    const { order, replayed } = await checkout(db, payments, { holdId: hold.id, userId: "ana", idempotencyKey: "key-0001" });
    expect(replayed).toBe(false);
    expect(order.amountCents).toBe(10_000);
    expect(order.seatIds).toEqual([1, 2]);
    expect(await statusOf(1)).toBe("sold");
    expect((await checkInvariants(db)).ok).toBe(true);
  });

  it("returns the same order when retried with the same key, charging once", async () => {
    const payments = scripted();
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1] });
    const input = { holdId: hold.id, userId: "ana", idempotencyKey: "key-0001" };
    const first = await checkout(db, payments, input);
    const second = await checkout(db, payments, input);
    expect(second.replayed).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(payments.chargesMade).toBe(1);
  });

  it("rejects reusing a key for a different hold", async () => {
    const payments = scripted();
    const a = await holdSeats(db, { eventId, userId: "ana", seatIds: [1] });
    const b = await holdSeats(db, { eventId, userId: "ana", seatIds: [2] });
    await checkout(db, payments, { holdId: a.id, userId: "ana", idempotencyKey: "key-0001" });
    await expect(
      checkout(db, payments, { holdId: b.id, userId: "ana", idempotencyKey: "key-0001" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("scopes keys per user, so two buyers can use the same key and each pays", async () => {
    const payments = scripted();
    const a = await holdSeats(db, { eventId, userId: "ana", seatIds: [1] });
    const b = await holdSeats(db, { eventId, userId: "ben", seatIds: [2] });
    const ana = await checkout(db, payments, { holdId: a.id, userId: "ana", idempotencyKey: "checkout-1" });
    const ben = await checkout(db, payments, { holdId: b.id, userId: "ben", idempotencyKey: "checkout-1" });

    expect(ben.replayed).toBe(false);
    expect(ben.order.chargeId).not.toBe(ana.order.chargeId);
    expect(payments.chargesMade).toBe(2);
    expect((await checkInvariants(db)).ok).toBe(true);
  });

  it("keeps the hold after a decline so the buyer can retry with a new key", async () => {
    const payments = scripted("decline");
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1] });
    await expect(
      checkout(db, payments, { holdId: hold.id, userId: "ana", idempotencyKey: "key-0001" }),
    ).rejects.toMatchObject({ code: "PAYMENT_DECLINED" });
    expect(await statusOf(1)).toBe("held");

    const { order } = await checkout(db, payments, { holdId: hold.id, userId: "ana", idempotencyKey: "key-0002" });
    expect(order.seatIds).toEqual([1]);
  });

  it("resumes after a payment timeout without charging twice", async () => {
    const payments = scripted("timeout");
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1] });
    const input = { holdId: hold.id, userId: "ana", idempotencyKey: "key-0001" };
    // The card was charged, but the response was lost.
    await expect(checkout(db, payments, input)).rejects.toMatchObject({ code: "PAYMENT_PENDING" });
    expect(payments.chargesMade).toBe(1);

    // A second checkout with a different key must not start a second payment.
    await expect(
      checkout(db, payments, { ...input, idempotencyKey: "key-0002" }),
    ).rejects.toMatchObject({ code: "CHECKOUT_IN_PROGRESS" });

    const { order } = await checkout(db, payments, input);
    expect(order.seatIds).toEqual([1]);
    expect(payments.chargesMade).toBe(1);
    expect((await checkInvariants(db)).ok).toBe(true);
  });

  it("refuses to check out an expired hold", async () => {
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1], holdSeconds: -1 });
    await expect(
      checkout(db, scripted(), { holdId: hold.id, userId: "ana", idempotencyKey: "key-0001" }),
    ).rejects.toMatchObject({ code: "HOLD_EXPIRED" });
  });

  it("refuses an expired hold whose seat was already taken by someone else", async () => {
    const stale = await holdSeats(db, { eventId, userId: "ana", seatIds: [1], holdSeconds: -1 });
    await holdSeats(db, { eventId, userId: "ben", seatIds: [1] });
    await expect(
      checkout(db, scripted(), { holdId: stale.id, userId: "ana", idempotencyKey: "key-0001" }),
    ).rejects.toMatchObject({ status: 410 });
  });
});

describe("sweeper", () => {
  it("expires stale holds and frees their seats", async () => {
    await holdSeats(db, { eventId, userId: "ana", seatIds: [1, 2], holdSeconds: -1 });
    const result = await sweep(db, scripted());
    expect(result.expired).toBe(1);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM seats WHERE status = 'held'");
    expect(rows[0].n).toBe(0);
  });

  it("completes an abandoned checkout if the provider says it was charged", async () => {
    const payments = scripted("timeout");
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1] });
    await expect(
      checkout(db, payments, { holdId: hold.id, userId: "ana", idempotencyKey: "key-0001" }),
    ).rejects.toMatchObject({ code: "PAYMENT_PENDING" });

    // The buyer closed the tab. Fast-forward past the payment window.
    await db.query("UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1", [hold.id]);
    expect(await sweep(db, payments)).toMatchObject({ recovered: 1 });
    expect(await statusOf(1)).toBe("sold");
    expect((await checkInvariants(db)).ok).toBe(true);
  });

  it("releases an abandoned checkout that was never charged", async () => {
    const hold = await holdSeats(db, { eventId, userId: "ana", seatIds: [1] });
    // Simulate a crash between phase 1 and the payment call.
    await db.query(
      "UPDATE holds SET status = 'paying', checkout_key = 'key-0001', expires_at = now() - interval '1 second' WHERE id = $1",
      [hold.id],
    );
    await db.query("UPDATE seats SET held_until = now() - interval '1 second' WHERE hold_id = $1", [hold.id]);
    expect(await sweep(db, scripted())).toMatchObject({ released: 1 });
    expect(await statusOf(1)).toBe("available");
  });
});
