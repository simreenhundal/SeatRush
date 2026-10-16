import type { Db } from "./db.js";

/**
 * Business rules that must hold no matter how much concurrent traffic hit the
 * system. Run after every load test: zero violations means nothing was
 * oversold, double-charged, or lost.
 */
const CHECKS: { rule: string; sql: string }[] = [
  {
    rule: "Every sold seat belongs to a confirmed hold",
    sql: `SELECT s.id FROM seats s LEFT JOIN holds h ON h.id = s.hold_id
          WHERE s.status = 'sold' AND (h.id IS NULL OR h.status <> 'confirmed')`,
  },
  {
    rule: "Every confirmed hold has exactly one order",
    sql: `SELECT h.id FROM holds h LEFT JOIN orders o ON o.hold_id = h.id
          WHERE h.status = 'confirmed' GROUP BY h.id HAVING count(o.id) <> 1`,
  },
  {
    rule: "Every order owns at least one sold seat",
    sql: `SELECT o.id FROM orders o LEFT JOIN seats s ON s.hold_id = o.hold_id AND s.status = 'sold'
          GROUP BY o.id HAVING count(s.id) = 0`,
  },
  {
    rule: "Every order charged exactly seats x price",
    sql: `SELECT o.id FROM orders o
          JOIN seats s ON s.hold_id = o.hold_id
          JOIN events e ON e.id = s.event_id
          GROUP BY o.id, o.amount_cents
          HAVING o.amount_cents <> count(s.id) * max(e.price_cents)`,
  },
  {
    rule: "No seat is held by an inactive hold",
    sql: `SELECT s.id FROM seats s JOIN holds h ON h.id = s.hold_id
          WHERE s.status = 'held' AND h.status IN ('released', 'confirmed')`,
  },
];

export async function checkInvariants(db: Db) {
  const violations: { rule: string; count: number }[] = [];
  for (const { rule, sql } of CHECKS) {
    const { rowCount } = await db.query(sql);
    if (rowCount) violations.push({ rule, count: rowCount });
  }
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM seats WHERE status = 'sold')::int AS sold_seats,
            (SELECT count(*) FROM orders)::int AS orders,
            (SELECT coalesce(sum(amount_cents), 0) FROM orders)::int AS revenue_cents`,
  );
  return { ok: violations.length === 0, violations, rulesChecked: CHECKS.length, stats: rows[0] };
}
