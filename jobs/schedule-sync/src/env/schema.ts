import "dotenv/config";
import { z } from "zod";

// The Schedule store's variables are read by createScheduleStore
const envSchema = z.object({
  SCHEDULE_URL: z
    .url()
    .default(
      "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip",
    ),
});

export const env = envSchema.parse(process.env);
