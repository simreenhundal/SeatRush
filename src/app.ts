import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { z } from "zod";
import { checkout, createEvent, holdSeats, listSeats, MAX_SEATS_PER_HOLD, releaseHold } from "./booking.js";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import type { PaymentProvider } from "./payments.js";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const CreateEventBody = z.object({
  name: z.string().min(1).max(200),
  priceCents: z.number().int().min(0),
  seatCount: z.number().int().min(1).max(10_000),
});
const HoldBody = z.object({
  eventId: z.number().int().positive(),
  seatIds: z.array(z.number().int().positive()).min(1).max(MAX_SEATS_PER_HOLD),
});
const IdParam = z.coerce.number().int().positive();
const UuidParam = z.uuid();
// Stand-in for real auth: the caller identifies themselves with a header.
const UserId = z.string().min(1).max(100);
const IdempotencyKey = z.string().min(8).max(200);

function userId(req: Request) {
  return parse(UserId, req.header("x-user-id"), "X-User-Id header");
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || what}: ${i.message}`).join("; ");
    throw new AppError(400, "VALIDATION_ERROR", detail);
  }
  return result.data;
}

export function createApp(db: Db, payments: PaymentProvider) {
  const app = express();
  app.use(express.json({ limit: "10kb" }));

  // Every request gets an id that appears in its logs and its error responses.
  app.use((req, res, next) => {
    const id = req.header("x-request-id") ?? randomUUID();
    res.locals.requestId = id;
    res.setHeader("x-request-id", id);
    const start = performance.now();
    res.on("finish", () =>
      logger.info(
        { requestId: id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(performance.now() - start) },
        "request",
      ),
    );
    next();
  });

  app.get("/health", async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ ok: true });
  });

  app.post("/events", async (req, res) => {
    const body = parse(CreateEventBody, req.body, "body");
    res.status(201).json(await createEvent(db, body));
  });

  app.get("/events/:id/seats", async (req, res) => {
    const eventId = parse(IdParam, req.params.id, "id");
    res.json({ eventId, seats: await listSeats(db, eventId) });
  });

  app.post("/holds", async (req, res) => {
    const body = parse(HoldBody, req.body, "body");
    const hold = await holdSeats(db, { ...body, userId: userId(req) });
    res.status(201).json(hold);
  });

  app.post("/holds/:id/release", async (req, res) => {
    await releaseHold(db, parse(UuidParam, req.params.id, "id"), userId(req));
    res.status(204).end();
  });

  app.post("/holds/:id/checkout", async (req, res) => {
    const idempotencyKey = parse(IdempotencyKey, req.header("idempotency-key"), "Idempotency-Key header");
    const { order, replayed } = await checkout(db, payments, {
      holdId: parse(UuidParam, req.params.id, "id"),
      userId: userId(req),
      idempotencyKey,
    });
    res.status(replayed ? 200 : 201).json(order);
  });

  app.use((_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Route not found")));

  // One error shape for every failure: { error: { code, message, requestId } }
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.locals.requestId;
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, requestId } });
    }
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: { code: "INVALID_JSON", message: "Malformed JSON body", requestId } });
    }
    logger.error({ err, requestId }, "unhandled error");
    res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong", requestId } });
  });

  return app;
}
