import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env/schema";

export function createDatabaseConnection() {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 20,
    min: 0,
    idleTimeoutMillis: 30000,
    // fail fast instead of waiting for the OS TCP timeout
    connectionTimeoutMillis: 5000,
    query_timeout: 30000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    maxLifetimeSeconds: 1800,
    application_name: "tfi-gtfs",
    allowExitOnIdle: false,
  });

  pool.on("error", (err) => {
    // biome-ignore lint/suspicious/noConsole: pool error
    console.error("Unexpected pool error:", err);
  });

  return drizzle(pool);
}
