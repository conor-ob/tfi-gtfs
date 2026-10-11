import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  ScheduleImport,
  ScheduleImportRepository,
  ScheduleStaging,
  ScheduleTableName,
  ScheduleTables,
} from "@tfi-gtfs/tfi-gtfs-core";
import { desc, getTableColumns } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ClientBase } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import {
  agencyTable,
  calendarDatesTable,
  calendarTable,
  feedInfoTable,
  routesTable,
  scheduleImportTable,
  stopsTable,
  stopTimesTable,
  tripsTable,
} from "../db/schema";

const ACTIVE = "gtfs";
const STAGING = "gtfs_staging";
const OLD = "gtfs_old";

// Arbitrary key for the session-level advisory lock that stops two imports
// from sharing the staging schema
const IMPORT_LOCK_KEY = 4_201_101;

const COPY_BATCH_ROWS = 1000;

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

// Core's row types must match the table definitions exactly, so rows can be
// written column by column without mapping
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const _rowTypesMatchTables: {
  [T in ScheduleTableName]: Equals<
    ScheduleTables[T],
    (typeof scheduleTables)[T]["$inferSelect"]
  >;
} = {
  agency: true,
  routes: true,
  trips: true,
  stops: true,
  calendar: true,
  calendar_dates: true,
  stop_times: true,
  feed_info: true,
};

export class ScheduleImportRepositoryImpl implements ScheduleImportRepository {
  constructor(
    private readonly database: NodePgDatabase,
    // A dedicated connection without the pool's query timeout: COPY and index
    // builds on stop_times take far longer than any request
    private readonly connect: () => Promise<ClientBase & { end(): unknown }>,
  ) {
    this.database = database;
    this.connect = connect;
  }

  async findLatestImport(): Promise<ScheduleImport | null> {
    const [latest] = await this.database
      .select({
        feedVersion: scheduleImportTable.feedVersion,
        etag: scheduleImportTable.etag,
      })
      .from(scheduleImportTable)
      .orderBy(desc(scheduleImportTable.importedAt))
      .limit(1);
    return latest ?? null;
  }

  async createStaging(): Promise<ScheduleStaging> {
    const client = await this.connect();
    try {
      const {
        rows: [lock],
      } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [IMPORT_LOCK_KEY],
      );
      if (!lock?.locked) {
        throw new Error("Another Schedule Import is already running");
      }
      // Left behind if a previous import crashed
      await client.query(`DROP SCHEMA IF EXISTS ${STAGING} CASCADE`);
      await client.query(`CREATE SCHEMA ${STAGING}`);
      // Indexes, including primary keys, are built after loading (see check)
      for (const table of await activeTables(client)) {
        await client.query(
          `CREATE TABLE ${STAGING}."${table}" (LIKE ${ACTIVE}."${table}" INCLUDING ALL EXCLUDING INDEXES)`,
        );
      }
      return new PostgresScheduleStaging(client);
    } catch (error) {
      // Ending the session also releases the advisory lock
      await client.end();
      throw error;
    }
  }
}

class PostgresScheduleStaging implements ScheduleStaging {
  constructor(private readonly client: ClientBase & { end(): unknown }) {
    this.client = client;
  }

  async load<T extends ScheduleTableName>(
    table: T,
    rows: AsyncIterable<ScheduleTables[T]>,
  ): Promise<number> {
    const columns = Object.entries(getTableColumns(scheduleTables[table]));
    const keys = columns.map(([key]) => key as keyof ScheduleTables[T]);
    const names = columns.map(([, column]) => `"${column.name}"`).join(", ");

    let count = 0;
    async function* csv() {
      let batch = "";
      for await (const row of rows) {
        batch += `${keys.map((key) => csvField(row[key])).join(",")}\n`;
        if (++count % COPY_BATCH_ROWS === 0) {
          yield batch;
          batch = "";
        }
      }
      if (batch) yield batch;
    }

    await pipeline(
      Readable.from(csv()),
      this.client.query(
        copyFrom(
          `COPY ${STAGING}."${table}" (${names}) FROM STDIN WITH (FORMAT csv)`,
        ),
      ),
    );
    return count;
  }

  async check(): Promise<string[]> {
    await this.buildIndexes();
    for (const table of Object.keys(scheduleTables)) {
      await this.client.query(`ANALYZE ${STAGING}."${table}"`);
    }

    const problems: string[] = [];
    for (const table of ["agency", "routes", "trips", "stops", "stop_times"]) {
      const count = await this.count(`SELECT 1 FROM ${STAGING}."${table}"`);
      if (count === 0) problems.push(`${table} is empty`);
    }
    const feedInfo = await this.count(`SELECT 1 FROM ${STAGING}.feed_info`);
    if (feedInfo !== 1) {
      problems.push(`feed_info has ${feedInfo} rows, expected 1`);
    }

    const references: [string, string][] = [
      [
        "routes reference unknown agencies",
        `SELECT 1 FROM ${STAGING}.routes r
         WHERE NOT EXISTS (SELECT 1 FROM ${STAGING}.agency a WHERE a.agency_id = r.agency_id)`,
      ],
      [
        "trips reference unknown routes",
        `SELECT 1 FROM ${STAGING}.trips t
         WHERE NOT EXISTS (SELECT 1 FROM ${STAGING}.routes r WHERE r.route_id = t.route_id)`,
      ],
      [
        "trips reference unknown Service Calendars",
        `SELECT 1 FROM ${STAGING}.trips t
         WHERE NOT EXISTS (SELECT 1 FROM ${STAGING}.calendar c WHERE c.service_id = t.service_id)
           AND NOT EXISTS (SELECT 1 FROM ${STAGING}.calendar_dates d WHERE d.service_id = t.service_id)`,
      ],
      [
        "stop_times reference unknown trips",
        `SELECT 1 FROM ${STAGING}.stop_times st
         WHERE NOT EXISTS (SELECT 1 FROM ${STAGING}.trips t WHERE t.trip_id = st.trip_id)`,
      ],
      [
        "stop_times reference unknown stops",
        `SELECT 1 FROM ${STAGING}.stop_times st
         WHERE NOT EXISTS (SELECT 1 FROM ${STAGING}.stops s WHERE s.stop_id = st.stop_id)`,
      ],
      [
        "stops reference unknown parent stations",
        `SELECT 1 FROM ${STAGING}.stops s
         WHERE s.parent_station IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${STAGING}.stops p WHERE p.stop_id = s.parent_station)`,
      ],
    ];
    for (const [problem, query] of references) {
      const count = await this.count(query);
      if (count > 0) problems.push(`${count} ${problem}`);
    }
    return problems;
  }

  async publish(scheduleImport: ScheduleImport): Promise<void> {
    try {
      await this.client.query("BEGIN");
      // Renaming waits for readers of the active Schedule, and every new
      // reader queues behind it, so give up rather than stall requests
      await this.client.query("SET LOCAL lock_timeout = '10s'");
      await this.client.query(`ALTER SCHEMA ${ACTIVE} RENAME TO ${OLD}`);
      await this.client.query(`ALTER SCHEMA ${STAGING} RENAME TO ${ACTIVE}`);
      await this.client.query(`DROP SCHEMA ${OLD} CASCADE`);
      await this.client.query(
        "INSERT INTO schedule_import (feed_version, etag) VALUES ($1, $2)",
        [scheduleImport.feedVersion, scheduleImport.etag],
      );
      await this.client.query("COMMIT");
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
    await this.client.end();
  }

  async discard(): Promise<void> {
    try {
      await this.client.query(`DROP SCHEMA IF EXISTS ${STAGING} CASCADE`);
    } finally {
      await this.client.end();
    }
  }

  /** Recreates the active Schedule's primary keys and indexes on staging */
  private async buildIndexes() {
    const { rows: constraints } = await this.client.query<{
      table: string;
      name: string;
      definition: string;
    }>(
      `SELECT rel.relname AS table, con.conname AS name,
              pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = $1 AND con.contype IN ('p', 'u')`,
      [ACTIVE],
    );
    for (const { table, name, definition } of constraints) {
      await this.client.query(
        `ALTER TABLE ${STAGING}."${table}" ADD CONSTRAINT "${name}" ${definition}`,
      );
    }

    const { rows: indexes } = await this.client.query<{ definition: string }>(
      `SELECT indexdef AS definition FROM pg_indexes
       WHERE schemaname = $1 AND indexname NOT IN (
         SELECT con.conname FROM pg_constraint con
         JOIN pg_namespace ns ON ns.oid = con.connamespace
         WHERE ns.nspname = $1
       )`,
      [ACTIVE],
    );
    for (const { definition } of indexes) {
      await this.client.query(
        definition.replace(` ON ${ACTIVE}.`, ` ON ${STAGING}.`),
      );
    }
  }

  private async count(query: string) {
    const { rows } = await this.client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM (${query}) q`,
    );
    return rows[0]?.count ?? 0;
  }
}

async function activeTables(client: ClientBase) {
  const { rows } = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = $1",
    [ACTIVE],
  );
  return rows.map((row) => row.tablename);
}

/** One COPY CSV field: unquoted empty is NULL, quoted empty is "" */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "t" : "f";
  if (typeof value === "number") return String(value);
  return `"${String(value).replaceAll('"', '""')}"`;
}
