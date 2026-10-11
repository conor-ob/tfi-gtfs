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
});

export const env = envSchema.parse(process.env);
