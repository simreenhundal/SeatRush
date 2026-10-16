import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import { FakePaymentProvider } from "../src/payments.js";
import { resetDb, setupDb } from "./helpers.js";

let db: Db;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await setupDb();
  app = createApp(db, new FakePaymentProvider());
});
afterAll(() => db.end());
beforeEach(() => resetDb(db));

async function newEvent() {
  const res = await request(app).post("/events").send({ name: "Show", priceCents: 2500, seatCount: 10 });
  return res.body.id as number;
}

describe("HTTP API", () => {
  it("runs the full flow: create, hold, checkout, replay", async () => {
    const eventId = await newEvent();

    const hold = await request(app).post("/holds").set("X-User-Id", "ana").send({ eventId, seatIds: [1, 2] });
    expect(hold.status).toBe(201);

    const pay = () =>
      request(app).post(`/holds/${hold.body.id}/checkout`).set("X-User-Id", "ana").set("Idempotency-Key", "checkout-001");
    const first = await pay();
    expect(first.status).toBe(201);
    expect(first.body.amountCents).toBe(5000);

    const replay = await pay();
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);

    const seats = await request(app).get(`/events/${eventId}/seats`);
    expect(seats.body.seats.filter((s: any) => s.status === "sold")).toHaveLength(2);
  });

  it("returns 409 when the seat is taken", async () => {
    const eventId = await newEvent();
    await request(app).post("/holds").set("X-User-Id", "ana").send({ eventId, seatIds: [1] });
    const res = await request(app).post("/holds").set("X-User-Id", "ben").send({ eventId, seatIds: [1] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SEATS_UNAVAILABLE");
  });

  it("validates input with one consistent error shape", async () => {
    const res = await request(app).post("/holds").set("X-User-Id", "ana").send({ eventId: "abc", seatIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("requires the user header and the idempotency key", async () => {
    const eventId = await newEvent();
    expect((await request(app).post("/holds").send({ eventId, seatIds: [1] })).status).toBe(400);

    const hold = await request(app).post("/holds").set("X-User-Id", "ana").send({ eventId, seatIds: [1] });
    const res = await request(app).post(`/holds/${hold.body.id}/checkout`).set("X-User-Id", "ana");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Idempotency-Key/);
  });

  it("handles malformed JSON and unknown routes", async () => {
    const bad = await request(app).post("/events").set("Content-Type", "application/json").send("{oops");
    expect(bad.body.error.code).toBe("INVALID_JSON");
    expect((await request(app).get("/nope")).status).toBe(404);
  });
});
