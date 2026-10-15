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
  // How often to check the Schedule store for a new Schedule file; its own
  // variables are read by createScheduleStore (see docs/adr/0011)
  SCHEDULE_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(300),
  NTA_API_KEY: z.string().min(1),
  REALTIME_URL: z
    .url()
    .default("https://api.nationaltransport.ie/gtfsr/v2/TripUpdates"),
  // The NTA throttles the API key but doesn't publish a rate
  REALTIME_REFRESH_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(10)
    .default(60),
  // Where Trip Updates live (see docs/adr/0009)
  TRIP_UPDATE_STORE: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.url().optional(),
  CI: z
    .string()
    .default("false")
    .transform((s) => s === "true")
    .pipe(z.boolean()),
});

export const env = envSchema
  .refine((env) => env.TRIP_UPDATE_STORE !== "redis" || env.REDIS_URL, {
    message: "REDIS_URL is required when TRIP_UPDATE_STORE is redis",
    path: ["REDIS_URL"],
  })
  .parse(process.env);
