import { getDatabaseUrlSchema } from "@tfi-gtfs/tfi-gtfs-utils";
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: getDatabaseUrlSchema(),
});

export const env = envSchema.parse(process.env);
