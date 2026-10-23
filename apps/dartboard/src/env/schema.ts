import { config as dotenv } from "dotenv";
import { z } from "zod";

export const envSchema = z.object({
  // Where `pnpm dev` proxies /api; Caddy reads it at runtime in production
  SERVER_URL: z.url(),
});

// a .env file must only contain keys declared in the schema
export const dotenvSchema = z.strictObject(envSchema.shape);
const { parsed, error } = dotenv({ encoding: "utf8", quiet: true });
// dotenv returns an empty object and an ENOENT error when there is no .env
if (error === undefined) {
  dotenvSchema.parse(parsed);
}
