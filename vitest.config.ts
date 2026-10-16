import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests share one database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    env: { LOG_LEVEL: "silent" },
  },
});
