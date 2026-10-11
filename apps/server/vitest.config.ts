/// <reference types="vitest" />
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    exclude: [...configDefaults.exclude],
    reporters: "verbose",
    // Tests don't read a developer's .env, so they run the same in CI
    env: {
      PORT: "4000",
      DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5432/tfi-gtfs-test",
      NTA_API_KEY: "test",
    },
  },
});
