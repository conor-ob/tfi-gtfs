import { getDatabaseUrlSchema } from "@tfi-gtfs/tfi-gtfs-utils";
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: getDatabaseUrlSchema(),
  SCHEDULE_URL: z
    .url()
    .default(
      "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip",
    ),
  // Comma-separated Watched Stop IDs (docs/adr/0007); unset keeps every Stop
  WATCHED_STOP_IDS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((stopId) => stopId.trim())
        .filter(Boolean),
    ),
});

export const env = envSchema.parse(process.env);
