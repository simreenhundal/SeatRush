import { randomUUID } from "node:crypto";
import { withTx, type Db, type Tx } from "./db.js";
import { AppError, conflict, notFound } from "./errors.js";
import { PaymentTimeoutError, type PaymentProvider } from "./payments.js";

export const HOLD_SECONDS = 300; // a hold lasts 5 minutes
export const PAYMENT_WINDOW_SECONDS = 60; // seats stay locked this long while paying
export const MAX_SEATS_PER_HOLD = 8;

export interface Hold {
  id: string;
  eventId: number;
  userId: string;
  status: "active" | "paying" | "confirmed" | "released" | "expired";
  expiresAt: Date;
  seatIds: number[];
}

export interface Order {
  id: string;
  holdId: string;
  userId: string;
  amountCents: number;
  chargeId: string;
  seatIds: number[];
}

// A seat can be claimed if it is free, or held by a hold whose time ran out.
// Expiry is therefore enforced by the query itself, so correctness never
// depends on a background job running on time.
const CLAIMABLE = `(status = 'available' OR (status = 'held' AND held_until < now()))`;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function createEvent(
  db: Db,
  input: { name: string; priceCents: number; seatCount: number },
) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO events (name, price_cents) VALUES ($1, $2) RETURNING id",
      [input.name, input.priceCents],
    );
    const eventId = Number(rows[0].id);
    // Seats are labelled in rows of 20: A1..A20, B1..B20, ...
    await tx.query(
      `INSERT INTO seats (event_id, label)
       SELECT $1, chr(65 + ((n - 1) / 20)::int) || ((n - 1) % 20 + 1)
       FROM generate_series(1, $2) AS n`,
      [eventId, input.seatCount],
    );
    return { id: eventId, ...input };
  });
}

export async function listSeats(db: Db, eventId: number) {
  const { rows } = await db.query(
    `SELECT id, label,
            CASE WHEN status = 'held' AND held_until < now() THEN 'available' ELSE status END AS status
     FROM seats WHERE event_id = $1 ORDER BY id`,
    [eventId],
  );
  return rows.map((r) => ({ id: Number(r.id), label: r.label, status: r.status }));
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

/**
 * Hold a set of seats for one user, all or nothing.
 *
 * The race this solves: two buyers click the same seat at the same moment.
 * A "check, then update" approach lets both pass the check before either
 * writes, and the seat sells twice. Here the check and the claim are the same
 * statement, so the database guarantees only one buyer gets each seat.
 */
export async function holdSeats(
  db: Db,
  input: { eventId: number; userId: string; seatIds: number[]; holdSeconds?: number },
): Promise<Hold> {
  const seatIds = [...new Set(input.seatIds)];
  if (seatIds.length === 0 || seatIds.length > MAX_SEATS_PER_HOLD) {
    throw new AppError(400, "INVALID_SEAT_COUNT", `Hold between 1 and ${MAX_SEATS_PER_HOLD} seats`);
  }
  const holdSeconds = input.holdSeconds ?? HOLD_SECONDS;
  const holdId = randomUUID();

  return withTx(db, async (tx) => {
    const { rows: holdRows } = await tx.query(
      `INSERT INTO holds (id, event_id, user_id, status, expires_at)
       VALUES ($1, $2, $3, 'active', now() + make_interval(secs => $4))
       RETURNING expires_at`,
      [holdId, input.eventId, input.userId, holdSeconds],
    );
    const expiresAt: Date = holdRows[0].expires_at;

    // Lock the requested seats in id order, then claim them in one statement.
    // - FOR UPDATE inside the subquery locks rows in a consistent order, so two
    //   buyers wanting overlapping seats wait on each other instead of deadlocking.
    // - If a row changed while we waited for its lock, Postgres re-checks the
    //   WHERE clause against the new version and skips it if it's no longer claimable.
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE seats SET status = 'held', hold_id = $1, held_until = $2
       WHERE id IN (
         SELECT id FROM seats
         WHERE event_id = $3 AND id = ANY($4::bigint[]) AND ${CLAIMABLE}
         ORDER BY id
         FOR UPDATE
       )
       RETURNING id`,
      [holdId, expiresAt, input.eventId, seatIds],
    );

    // All or nothing: if we didn't get every seat, roll back the whole hold.
    if (rows.length !== seatIds.length) {
      throw conflict("SEATS_UNAVAILABLE", "One or more seats are no longer available");
    }

    return {
      id: holdId,
      eventId: input.eventId,
      userId: input.userId,
      status: "active",
      expiresAt,
      seatIds: rows.map((r) => Number(r.id)).sort((a, b) => a - b),
    };
  });
}

export async function releaseHold(db: Db, holdId: string, userId: string) {
  await withTx(db, async (tx) => {
    const hold = await lockHold(tx, holdId, userId);
    if (hold.status !== "active") {
      throw conflict("HOLD_NOT_ACTIVE", `Hold is ${hold.status}`);
    }
    await freeSeats(tx, [holdId]);
    await tx.query("UPDATE holds SET status = 'released' WHERE id = $1", [holdId]);
  });
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * Pay for a hold and turn its seats into sold seats.
 *
 * Runs in three phases so the slow network call to the payment provider
 * never happens while database locks are held:
 *   1. Short transaction: validate the hold, move it to 'paying', extend its seats.
 *   2. Call the provider with the idempotency key (no locks held).
 *   3. Short transaction: record the order and mark seats sold, or roll back to 'active'.
 *
 * Retrying with the same Idempotency-Key is always safe. It either returns
 * the existing order or resumes an interrupted payment, and because the
 * provider is idempotent too, the customer is never charged twice.
 */
export async function checkout(
  db: Db,
  payments: PaymentProvider,
  input: { holdId: string; userId: string; idempotencyKey: string },
): Promise<{ order: Order; replayed: boolean }> {
  const { holdId, userId, idempotencyKey } = input;

  // Fast path: this exact request already succeeded.
  const existing = await findOrderByKey(db, idempotencyKey);
  if (existing) {
    if (existing.holdId !== holdId) {
      throw new AppError(422, "IDEMPOTENCY_KEY_REUSED", "Key was already used for a different hold");
    }
    return { order: existing, replayed: true };
  }

  // Phase 1
  const start = await withTx(db, async (tx) => {
    const hold = await lockHold(tx, holdId, userId);

    if (hold.status === "confirmed") return { done: await findOrderByHold(tx, holdId) };
    if (hold.status === "paying") {
      if (hold.checkout_key !== idempotencyKey) {
        throw conflict("CHECKOUT_IN_PROGRESS", "Another checkout for this hold is in progress");
      }
      // Same key: an earlier attempt was interrupted. Fall through and resume.
    } else if (hold.status !== "active" || hold.expires_at <= new Date()) {
      throw new AppError(410, "HOLD_EXPIRED", "Hold has expired or was released");
    }

    const { rows } = await tx.query(
      `SELECT count(*)::int AS seats, e.price_cents
       FROM seats s JOIN events e ON e.id = s.event_id
       WHERE s.hold_id = $1 AND s.status = 'held'
       GROUP BY e.price_cents`,
      [holdId],
    );
    if (rows.length === 0) throw new AppError(410, "HOLD_EXPIRED", "Hold no longer owns any seats");

    // Lock the seats for the payment window so nobody can reclaim them mid-payment.
    await tx.query(
      `UPDATE seats SET held_until = now() + make_interval(secs => $2)
       WHERE hold_id = $1 AND status = 'held'`,
      [holdId, PAYMENT_WINDOW_SECONDS],
    );
    await tx.query(
      `UPDATE holds SET status = 'paying', checkout_key = $2,
              expires_at = now() + make_interval(secs => $3)
       WHERE id = $1`,
      [holdId, idempotencyKey, PAYMENT_WINDOW_SECONDS],
    );
    return { amountCents: rows[0].seats * rows[0].price_cents };
  });
  if ("done" in start && start.done) return { order: start.done, replayed: true };

  // Phase 2
  let result;
  try {
    result = await payments.charge({ amountCents: start.amountCents!, idempotencyKey });
  } catch (err) {
    if (err instanceof PaymentTimeoutError) {
      // We don't know if the card was charged. Leave the hold in 'paying';
      // a retry with the same key, or the sweeper, will resolve it.
      throw new AppError(503, "PAYMENT_PENDING", "Payment status unknown; retry with the same Idempotency-Key");
    }
    throw err;
  }

  // Phase 3
  if (!result.ok) {
    await withTx(db, async (tx) => {
      const hold = await lockHold(tx, holdId, userId);
      if (hold.status === "paying") {
        await tx.query("UPDATE holds SET status = 'active', checkout_key = NULL WHERE id = $1", [holdId]);
      }
    });
    throw new AppError(402, "PAYMENT_DECLINED", `Payment declined: ${result.reason}`);
  }

  const order = await withTx(db, (tx) =>
    confirmHold(tx, holdId, idempotencyKey, start.amountCents!, result.chargeId),
  );
  return { order, replayed: false };
}

/** Phase 3 on success. Safe to call twice: the second call returns the existing order. */
async function confirmHold(
  tx: Tx,
  holdId: string,
  idempotencyKey: string,
  amountCents: number,
  chargeId: string,
): Promise<Order> {
  const { rows } = await tx.query("SELECT * FROM holds WHERE id = $1 FOR UPDATE", [holdId]);
  const hold = rows[0];
  if (hold.status === "confirmed") return (await findOrderByHold(tx, holdId))!;
  if (hold.status !== "paying") {
    // Should be impossible while seats are locked for the payment window. If it
    // happens, the customer was charged without getting seats, so fail loudly.
    throw new AppError(500, "INCONSISTENT_STATE", `Charged hold ${holdId} is ${hold.status}`);
  }

  const sold = await tx.query(
    "UPDATE seats SET status = 'sold', held_until = NULL WHERE hold_id = $1 AND status = 'held' RETURNING id",
    [holdId],
  );
  await tx.query("UPDATE holds SET status = 'confirmed' WHERE id = $1", [holdId]);
  const orderId = randomUUID();
  await tx.query(
    `INSERT INTO orders (id, hold_id, user_id, amount_cents, charge_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, holdId, hold.user_id, amountCents, chargeId, idempotencyKey],
  );
  return {
    id: orderId,
    holdId,
    userId: hold.user_id,
    amountCents,
    chargeId,
    seatIds: sold.rows.map((r) => Number(r.id)).sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

/**
 * Background cleanup. Correctness doesn't depend on it, since expired seats are
 * claimable anyway, but it keeps state tidy and resolves stuck payments.
 */
export async function sweep(db: Db, payments: PaymentProvider) {
  const expired = await withTx(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE holds SET status = 'expired'
       WHERE status = 'active' AND expires_at < now()
       RETURNING id`,
    );
    const ids = rows.map((r) => r.id);
    if (ids.length) await freeSeats(tx, ids);
    return ids.length;
  });

  // Holds stuck in 'paying' past their window: ask the provider what happened.
  const { rows: stuck } = await db.query(
    "SELECT id, checkout_key FROM holds WHERE status = 'paying' AND expires_at < now()",
  );
  let recovered = 0;
  let released = 0;
  for (const hold of stuck) {
    const charge = await payments.lookup(hold.checkout_key);
    const outcome = await withTx(db, async (tx) => {
      // Re-check under lock: a client retry may have resolved it meanwhile.
      const { rows } = await tx.query(
        "SELECT status, expires_at FROM holds WHERE id = $1 FOR UPDATE",
        [hold.id],
      );
      if (rows[0].status !== "paying" || rows[0].expires_at >= new Date()) return "skipped";

      if (charge?.ok) {
        const { rows: amount } = await tx.query(
          `SELECT count(*)::int * max(e.price_cents) AS cents
           FROM seats s JOIN events e ON e.id = s.event_id WHERE s.hold_id = $1`,
          [hold.id],
        );
        await confirmHold(tx, hold.id, hold.checkout_key, amount[0].cents, charge.chargeId);
        return "recovered";
      }
      await freeSeats(tx, [hold.id]);
      await tx.query("UPDATE holds SET status = 'expired' WHERE id = $1", [hold.id]);
      return "released";
    });
    if (outcome === "recovered") recovered++;
    if (outcome === "released") released++;
  }
  return { expired, recovered, released };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function lockHold(tx: Tx, holdId: string, userId: string) {
  const { rows } = await tx.query("SELECT * FROM holds WHERE id = $1 FOR UPDATE", [holdId]);
  // Same error for "missing" and "someone else's", so hold ids can't be probed.
  if (rows.length === 0 || rows[0].user_id !== userId) throw notFound("Hold");
  return rows[0];
}

async function freeSeats(tx: Tx, holdIds: string[]) {
  await tx.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
     WHERE hold_id = ANY($1::uuid[]) AND status = 'held'`,
    [holdIds],
  );
}

async function findOrderByKey(db: Db | Tx, key: string) {
  return mapOrder(db, "o.idempotency_key = $1", key);
}

async function findOrderByHold(db: Db | Tx, holdId: string) {
  return mapOrder(db, "o.hold_id = $1", holdId);
}

async function mapOrder(db: Db | Tx, where: string, param: string): Promise<Order | null> {
  const { rows } = await db.query(
    `SELECT o.*, array_agg(s.id ORDER BY s.id) AS seat_ids
     FROM orders o JOIN seats s ON s.hold_id = o.hold_id
     WHERE ${where} GROUP BY o.id`,
    [param],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    holdId: r.hold_id,
    userId: r.user_id,
    amountCents: r.amount_cents,
    chargeId: r.charge_id,
    seatIds: r.seat_ids.map(Number),
  };
}
