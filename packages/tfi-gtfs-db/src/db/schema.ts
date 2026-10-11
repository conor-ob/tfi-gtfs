import { pgSchema } from "drizzle-orm/pg-core";

// Static GTFS tables live in their own Postgres schema so a schedule import
// can be swapped in atomically (see docs/adr/0003-schedule-import-schema-swap.md).
// Tables in `public` must never hold foreign keys into this schema.
export const gtfsSchema = pgSchema("gtfs");
