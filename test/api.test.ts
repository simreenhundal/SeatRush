import { SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import { FakePaymentProvider } from "../src/payments.js";
import { authSecret, resetDb, setupDb, tokenFor } from "./helpers.js";

let db: Db;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await setupDb();
  app = createApp(db, new FakePaymentProvider(), authSecret);
});
afterAll(() => db.end());
beforeEach(() => resetDb(db));

async function bearer(userId: string, role: "user" | "admin" = "user") {
  return `Bearer ${await tokenFor(userId, role)}`;
}

async function newEvent() {
  const res = await request(app)
    .post("/events")
    .set("Authorization", await bearer("admin-1", "admin"))
    .send({ name: "Show", priceCents: 2500, seatCount: 10 });
  return res.body.id as number;
}

async function holdAs(userId: string, eventId: number, seatIds: number[]) {
  return request(app).post("/holds").set("Authorization", await bearer(userId)).send({ eventId, seatIds });
}

describe("HTTP API", () => {
  it("runs the full flow: create, hold, checkout, replay", async () => {
    const eventId = await newEvent();
    const hold = await holdAs("ana", eventId, [1, 2]);
    expect(hold.status).toBe(201);

    const auth = await bearer("ana");
    const pay = () =>
      request(app).post(`/holds/${hold.body.id}/checkout`).set("Authorization", auth).set("Idempotency-Key", "checkout-001");
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
    await holdAs("ana", eventId, [1]);
    const res = await holdAs("ben", eventId, [1]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SEATS_UNAVAILABLE");
  });

  it("validates input with one consistent error shape", async () => {
    const res = await request(app)
      .post("/holds")
      .set("Authorization", await bearer("ana"))
      .send({ eventId: "abc", seatIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("requires an idempotency key on checkout", async () => {
    const eventId = await newEvent();
    const hold = await holdAs("ana", eventId, [1]);
    const res = await request(app).post(`/holds/${hold.body.id}/checkout`).set("Authorization", await bearer("ana"));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Idempotency-Key/);
  });

  it("handles malformed JSON and unknown routes", async () => {
    const bad = await request(app).post("/events").set("Content-Type", "application/json").send("{oops");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_JSON");
    expect(bad.body.error.requestId).toBeTruthy();
    expect(bad.headers["x-request-id"]).toBe(bad.body.error.requestId);
    expect((await request(app).get("/nope")).status).toBe(404);
  });

  it("rejects an oversized body with 413, not 500", async () => {
    const res = await request(app)
      .post("/events")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ name: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("replaces an unsafe client request id instead of echoing it", async () => {
    const res = await request(app).get("/nope").set("X-Request-Id", "bad id<script>");
    expect(res.headers["x-request-id"]).not.toContain("<");
    const ok = await request(app).get("/nope").set("X-Request-Id", "trace-123");
    expect(ok.headers["x-request-id"]).toBe("trace-123");
  });
});

describe("auth", () => {
  it("rejects protected routes without a token", async () => {
    const eventId = await newEvent();
    const res = await request(app).post("/holds").send({ eventId, seatIds: [1] });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a token signed with a different secret", async () => {
    const forged = await new SignJWT({ role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("mallory")
      .setExpirationTime("1h")
      .sign(new Uint8Array(randomBytes(32)));
    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${forged}`)
      .send({ name: "Fake", priceCents: 1, seatCount: 1 });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({ role: "user" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("ana")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(authSecret);
    const res = await request(app).post("/holds").set("Authorization", `Bearer ${expired}`).send({ eventId: 1, seatIds: [1] });
    expect(res.status).toBe(401);
  });

  it("rejects an unsigned token", async () => {
    const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${encode({ alg: "none" })}.${encode({ sub: "mallory", role: "admin" })}.`;
    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${unsigned}`)
      .send({ name: "Fake", priceCents: 1, seatCount: 1 });
    expect(res.status).toBe(401);
  });

  it("only lets admins create events", async () => {
    const res = await request(app)
      .post("/events")
      .set("Authorization", await bearer("ana"))
      .send({ name: "Show", priceCents: 2500, seatCount: 10 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("does not let one user check out or release another user's hold", async () => {
    const eventId = await newEvent();
    const hold = await holdAs("ana", eventId, [1]);
    const ben = await bearer("ben");

    const pay = await request(app)
      .post(`/holds/${hold.body.id}/checkout`)
      .set("Authorization", ben)
      .set("Idempotency-Key", "ben-attempt-1");
    expect(pay.status).toBe(404);

    const release = await request(app).post(`/holds/${hold.body.id}/release`).set("Authorization", ben);
    expect(release.status).toBe(404);
  });

  it("does not leak another user's order through an idempotent replay", async () => {
    const eventId = await newEvent();
    const hold = await holdAs("ana", eventId, [1]);
    const checkoutAs = async (userId: string) =>
      request(app)
        .post(`/holds/${hold.body.id}/checkout`)
        .set("Authorization", await bearer(userId))
        .set("Idempotency-Key", "checkout-001");

    expect((await checkoutAs("ana")).status).toBe(201);
    const replay = await checkoutAs("ben");
    expect(replay.status).toBe(404);
    expect(replay.body.id).toBeUndefined();
  });
});
