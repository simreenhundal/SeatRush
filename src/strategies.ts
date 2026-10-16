import type { Db } from "./db.js";

// Isolated on a minimal table so the locking pattern is the only variable being
// compared. "naive" is deliberately broken to demonstrate the race.
export type Strategy = "naive" | "atomic" | "pessimistic" | "optimistic";
export const STRATEGIES: Strategy[] = ["naive", "atomic", "pessimistic", "optimistic"];

export async function setupBenchTable(db: Db, seatCount: number) {
  await db.query(`CREATE TABLE IF NOT EXISTS bench_seats (
    id INT PRIMARY KEY, owner TEXT, version INT NOT NULL DEFAULT 0)`);
  await db.query("TRUNCATE bench_seats");
  await db.query("INSERT INTO bench_seats (id) SELECT generate_series(1, $1)", [seatCount]);
}

export async function claim(db: Db, strategy: Strategy, seatId: number, buyer: string): Promise<boolean> {
  switch (strategy) {
    case "naive": {
      const { rows } = await db.query("SELECT owner FROM bench_seats WHERE id = $1", [seatId]);
      if (rows[0].owner !== null) return false;
      // The gap between the check and the write is where the race lives.
      // Any real work here (a pricing call, a log line) widens it.
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      await db.query("UPDATE bench_seats SET owner = $2 WHERE id = $1", [seatId, buyer]);
      return true;
    }

    case "atomic": {
      const { rowCount } = await db.query(
        "UPDATE bench_seats SET owner = $2 WHERE id = $1 AND owner IS NULL",
        [seatId, buyer],
      );
      return rowCount === 1;
    }

    case "pessimistic": {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT owner FROM bench_seats WHERE id = $1 FOR UPDATE", [seatId]);
        if (rows[0].owner !== null) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query("UPDATE bench_seats SET owner = $2 WHERE id = $1", [seatId, buyer]);
        await client.query("COMMIT");
        return true;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    case "optimistic": {
      for (let attempt = 0; attempt < 10; attempt++) {
        const { rows } = await db.query("SELECT owner, version FROM bench_seats WHERE id = $1", [seatId]);
        if (rows[0].owner !== null) return false;
        const { rowCount } = await db.query(
          "UPDATE bench_seats SET owner = $2, version = version + 1 WHERE id = $1 AND version = $3",
          [seatId, buyer, rows[0].version],
        );
        if (rowCount === 1) return true;
        // Someone changed the row since we read it: re-read and try again.
      }
      return false;
    }
  }
}
