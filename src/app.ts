import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { z } from "zod";
import { verifyToken, type AuthUser } from "./auth.js";
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
const IdempotencyKey = z.string().min(8).max(200);
// Client-supplied ids end up in logs and response headers, so only safe characters pass.
const RequestId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

function currentUser(res: Response): AuthUser {
  return res.locals.user;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || what}: ${i.message}`).join("; ");
    throw new AppError(400, "VALIDATION_ERROR", detail);
  }
  return result.data;
}

// express.json() reports client mistakes (bad JSON, oversized or unreadable
// bodies) as errors with a 4xx status and a `type`; these are not server faults.
function bodyParserError(err: unknown) {
  const { status, type } = (err ?? {}) as { status?: unknown; type?: unknown };
  if (typeof status !== "number" || status < 400 || status >= 500 || typeof type !== "string") return null;
  if (type === "entity.parse.failed") {
    return { status: 400, error: { code: "INVALID_JSON", message: "Malformed JSON body" } };
  }
  if (type === "entity.too.large") {
    return { status: 413, error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" } };
  }
  return { status, error: { code: "UNREADABLE_BODY", message: "Request body could not be read" } };
}

export function createApp(db: Db, payments: PaymentProvider, authSecret: Uint8Array) {
  const app = express();

  const requireAuth = (role?: AuthUser["role"]) => async (req: Request, res: Response, next: NextFunction) => {
    const user = await verifyToken(authSecret, req.header("authorization"));
    if (role && user.role !== role) throw new AppError(403, "FORBIDDEN", `Requires ${role} role`);
    res.locals.user = user;
    next();
  };

  app.use((req, res, next) => {
    const supplied = RequestId.safeParse(req.header("x-request-id"));
    const id = supplied.success ? supplied.data : randomUUID();
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

  // Registered after the request id so body errors carry one too.
  app.use(express.json({ limit: "10kb" }));

  app.get("/health", async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ ok: true });
  });

  app.post("/events", requireAuth("admin"), async (req, res) => {
    const body = parse(CreateEventBody, req.body, "body");
    res.status(201).json(await createEvent(db, body));
  });

  app.get("/events/:id/seats", async (req, res) => {
    const eventId = parse(IdParam, req.params.id, "id");
    res.json({ eventId, seats: await listSeats(db, eventId) });
  });

  app.post("/holds", requireAuth(), async (req, res) => {
    const body = parse(HoldBody, req.body, "body");
    const hold = await holdSeats(db, { ...body, userId: currentUser(res).id });
    res.status(201).json(hold);
  });

  app.post("/holds/:id/release", requireAuth(), async (req, res) => {
    await releaseHold(db, parse(UuidParam, req.params.id, "id"), currentUser(res).id);
    res.status(204).end();
  });

  app.post("/holds/:id/checkout", requireAuth(), async (req, res) => {
    const idempotencyKey = parse(IdempotencyKey, req.header("idempotency-key"), "Idempotency-Key header");
    const { order, replayed } = await checkout(db, payments, {
      holdId: parse(UuidParam, req.params.id, "id"),
      userId: currentUser(res).id,
      idempotencyKey,
    });
    res.status(replayed ? 200 : 201).json(order);
  });

  app.use((_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Route not found")));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.locals.requestId;
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, requestId } });
    }
    const bodyError = bodyParserError(err);
    if (bodyError) return res.status(bodyError.status).json({ error: { ...bodyError.error, requestId } });
    logger.error({ err, requestId }, "unhandled error");
    res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong", requestId } });
  });

  return app;
}
