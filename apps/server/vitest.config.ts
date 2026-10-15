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
      NTA_API_KEY: "test",
      // Nothing listens here, so a Realtime read fails at once instead of
      // calling the NTA
      REALTIME_URL: "http://127.0.0.1:9/",
    },
  },
});
