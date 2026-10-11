/// <reference types="vitest" />
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude],
    reporters: "verbose",
    env: {
      DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5432/tfi-gtfs-test",
    },
    // Tests share one database
    fileParallelism: false,
  },
});
