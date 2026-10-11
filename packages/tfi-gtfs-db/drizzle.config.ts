import { defineConfig } from "drizzle-kit";
import { env } from "./src/env/schema";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  schemaFilter: ["public", "gtfs"],
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
