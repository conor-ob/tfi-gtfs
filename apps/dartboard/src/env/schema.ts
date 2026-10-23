import { config as dotenv } from "dotenv";
import { z } from "zod";

export const envSchema = z.object({
  // Where `pnpm dev` proxies /api; point it at the deployed web app's /api to
  // use prod
  SERVER_URL: z.url().default("http://localhost:4000"),
});

// a .env file must only contain keys declared in the schema
export const dotenvSchema = z.strictObject(envSchema.shape);
const { parsed, error } = dotenv({ encoding: "utf8", quiet: true });
// dotenv returns an empty object and an ENOENT error when there is no .env
if (error === undefined) {
  dotenvSchema.parse(parsed);
}
