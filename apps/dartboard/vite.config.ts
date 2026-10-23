import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { envSchema } from "./src/env/schema";

export default defineConfig(({ mode }) => {
  const env = envSchema.parse(loadEnv(mode, process.cwd(), ""));

  return {
    plugins: [react(), tailwindcss()],
    server: {
      // Clear of apps/web's 5173, so both run under `pnpm dev`
      port: 5174,
      proxy: {
        // Caddy does the same in production (see Caddyfile)
        "/api": {
          target: env.API_PROXY_TARGET,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  };
});
