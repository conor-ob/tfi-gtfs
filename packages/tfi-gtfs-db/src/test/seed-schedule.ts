import type {
  ScheduleTableName,
  ScheduleTables,
} from "@tfi-gtfs/tfi-gtfs-core";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  agencyTable,
  calendarDatesTable,
  calendarTable,
  feedInfoTable,
  routesTable,
  stopsTable,
  stopTimesTable,
  tripsTable,
} from "../db/schema";

export type Rows = { [T in ScheduleTableName]: ScheduleTables[T][] };

const scheduleTables = {
  agency: agencyTable,
  routes: routesTable,
  trips: tripsTable,
  stops: stopsTable,
  calendar: calendarTable,
  calendar_dates: calendarDatesTable,
  stop_times: stopTimesTable,
  feed_info: feedInfoTable,
};

/**
 * Replaces the `gtfs` tables' rows with fixture rows. The Schedule Import no
 * longer writes Postgres (see
 * docs/adr/0011-full-schedule-served-from-sqlite-file-in-bucket.md), so the
 * read repositories' tests seed it directly
 */
export async function seedSchedule(database: NodePgDatabase, rows: Rows) {
  await database.transaction(async (tx) => {
    for (const table of Object.keys(scheduleTables) as ScheduleTableName[]) {
      await tx.execute(sql`TRUNCATE ${scheduleTables[table]}`);
      if (rows[table].length > 0) {
        await tx.insert(scheduleTables[table]).values(rows[table] as never[]);
      }
    }
  });
}
