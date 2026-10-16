import { randomUUID } from "node:crypto";

export type ChargeResult = { ok: true; chargeId: string } | { ok: false; reason: string };

/**
 * The payment provider contract. Like real providers (Stripe, Square), it
 * accepts an idempotency key: charging twice with the same key returns the
 * first result instead of charging the customer again.
 */
export interface PaymentProvider {
  charge(req: { amountCents: number; idempotencyKey: string }): Promise<ChargeResult>;
  /** Look up what happened to a charge, e.g. after a timeout. null = never charged. */
  lookup(idempotencyKey: string): Promise<ChargeResult | null>;
}

/** Thrown when we don't know whether the charge went through. */
export class PaymentTimeoutError extends Error {
  constructor() {
    super("Payment provider timed out");
  }
}

type Outcome = "success" | "decline" | "timeout";

/**
 * A fake provider for local runs and tests. `decide` picks each new charge's
 * outcome. A "timeout" charges the card but throws as if the response was
 * lost, which is the nastiest real-world case to handle.
 */
export class FakePaymentProvider implements PaymentProvider {
  private readonly results = new Map<string, ChargeResult>();
  public chargesMade = 0;

  constructor(
    private readonly decide: () => Outcome = () => "success",
    private readonly latencyMs = 0,
  ) {}

  static random(opts: { declineRate?: number; timeoutRate?: number; latencyMs?: number } = {}) {
    const { declineRate = 0, timeoutRate = 0, latencyMs = 0 } = opts;
    return new FakePaymentProvider(() => {
      const r = Math.random();
      if (r < declineRate) return "decline";
      if (r < declineRate + timeoutRate) return "timeout";
      return "success";
    }, latencyMs);
  }

  async charge({ idempotencyKey }: { amountCents: number; idempotencyKey: string }) {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const existing = this.results.get(idempotencyKey);
    if (existing) return existing; // idempotent replay: no second charge

    const outcome = this.decide();
    if (outcome === "decline") {
      const result: ChargeResult = { ok: false, reason: "card_declined" };
      this.results.set(idempotencyKey, result);
      return result;
    }
    const result: ChargeResult = { ok: true, chargeId: `ch_${randomUUID()}` };
    this.results.set(idempotencyKey, result);
    this.chargesMade++;
    if (outcome === "timeout") throw new PaymentTimeoutError();
    return result;
  }

  async lookup(idempotencyKey: string) {
    return this.results.get(idempotencyKey) ?? null;
  }
}
