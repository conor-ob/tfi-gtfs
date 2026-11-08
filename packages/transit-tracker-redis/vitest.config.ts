/// <reference types="vitest" />
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude],
    reporters: "verbose",
    env: {
      // Database 1 keeps tests apart from local development's database 0
      REDIS_URL: "redis://localhost:6379/1",
    },
  },
});
