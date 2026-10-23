import { scheduleStoreVariablesSchema } from "@tfi-gtfs/tfi-gtfs-utils";
import { config as dotenv } from "dotenv";
import { z } from "zod";

const { parsed, error } = dotenv({ encoding: "utf8", quiet: true });

// The Schedule store's variables are read by createScheduleStore
const envSchema = z.object({
  SCHEDULE_URL: z
    .url()
    .default(
      "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip",
    ),
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

export const env = envSchema.parse(process.env);
