import { createApp, logger } from "./app.js";
import { sweep } from "./booking.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { FakePaymentProvider } from "./payments.js";

const db = createPool(process.env.DATABASE_URL, Number(process.env.DB_POOL_SIZE ?? 20));

// The fake provider can be made flaky to exercise failure handling:
//   PAYMENT_DECLINE_RATE=0.1 PAYMENT_TIMEOUT_RATE=0.05 npm run dev
const payments = FakePaymentProvider.random({
  declineRate: Number(process.env.PAYMENT_DECLINE_RATE ?? 0),
  timeoutRate: Number(process.env.PAYMENT_TIMEOUT_RATE ?? 0),
  latencyMs: Number(process.env.PAYMENT_LATENCY_MS ?? 50),
});

await migrate(db);
const app = createApp(db, payments);
const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => logger.info({ port }, "SeatRush API listening"));

const sweeper = setInterval(() => {
  sweep(db, payments)
    .then((r) => (r.expired || r.recovered || r.released) && logger.info(r, "sweep"))
    .catch((err) => logger.error({ err }, "sweep failed"));
}, 10_000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(sweeper);
    server.close(() => db.end().then(() => process.exit(0)));
  });
}
