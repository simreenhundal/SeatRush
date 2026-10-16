// Exits non-zero on any violation so it can gate CI or follow a load test.
import { createPool } from "../src/db.js";
import { checkInvariants } from "../src/invariants.js";

const db = createPool();
const result = await checkInvariants(db);
await db.end();

console.log(`Checked ${result.rulesChecked} rules.`, result.stats);
if (result.ok) {
  console.log("All invariants hold.");
} else {
  console.error("VIOLATIONS:");
  for (const v of result.violations) console.error(`  ${v.rule}: ${v.count} rows`);
  process.exit(1);
}
