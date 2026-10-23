import { scheduleStoreVariablesSchema } from "@tfi-gtfs/tfi-gtfs-utils";
import { config as dotenv } from "dotenv";
import { z } from "zod";

const { parsed, error } = dotenv({ encoding: "utf8", quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"]),
  PORT: z.coerce.number().int(),
  // How often to check the Schedule store for a new Schedule file; its own
  // variables are read by createScheduleStore (see docs/adr/0011)
  SCHEDULE_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1),
  NTA_API_KEY: z.string().min(1),
  REALTIME_URL: z.url(),
  // The NTA throttles the API key but doesn't publish a rate
  REALTIME_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().min(60),
  // Where Trip Updates live (see docs/adr/0009)
  TRIP_UPDATE_STORE: z.enum(["memory", "redis"]),
  REDIS_URL: z.url().optional(),
});

// a .env file must only contain keys declared in the schema, or read by
// createScheduleStore
export const dotenvSchema = z.strictObject({
  ...envSchema.shape,
  ...scheduleStoreVariablesSchema.shape,
});
// dotenv returns an empty object and an ENOENT error when there is no .env
if (error === undefined) {
  dotenvSchema.parse(parsed);
}

export const env = envSchema
  .refine((env) => env.TRIP_UPDATE_STORE !== "redis" || env.REDIS_URL, {
    message: "REDIS_URL is required when TRIP_UPDATE_STORE is redis",
    path: ["REDIS_URL"],
  })
  .parse(process.env);
