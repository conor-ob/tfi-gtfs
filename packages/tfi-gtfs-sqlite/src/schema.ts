import { readFileSync } from "node:fs";

/**
 * The layout `schema.sql` creates, also its `PRAGMA user_version`. It is part
 * of the bucket path, so a server only reads files in the layout it knows
 */
export const SCHEDULE_SCHEMA_VERSION = 1;

/**
 * The Schedule file's schema. Read from beside this module, so a bundle must
 * copy `schema.sql` next to its output
 */
export function readScheduleSchema(): string {
  return readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
}
