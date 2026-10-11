import { getDatabaseUrlSchema } from "@tfi-gtfs/tfi-gtfs-utils";
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["production", "development", "test"])
    .default("development"),
  PORT: z
    .string()
    .transform((s) => parseInt(s, 10))
    .pipe(z.number()),
  // Browser origins allowed by CORS; none by default, since the owner's apps
  // don't call from a browser
  ORIGIN: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url())),
  DATABASE_URL: getDatabaseUrlSchema(),
  NTA_API_KEY: z.string().min(1),
  REALTIME_URL: z
    .url()
    .default("https://api.nationaltransport.ie/gtfsr/v2/TripUpdates"),
  // The NTA throttles the API key but doesn't publish a rate
  REALTIME_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
  CI: z
    .string()
    .default("false")
    .transform((s) => s === "true")
    .pipe(z.boolean()),
});

export const env = envSchema.parse(process.env);
