import { createReadStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  BuiltSchedule,
  ScheduleImport,
  ScheduleImportRepository,
  ScheduleStaging,
  ScheduleTableName,
  ScheduleTables,
} from "@tfi-gtfs/tfi-gtfs-core";
import { readScheduleSchema, SCHEDULE_SCHEMA_VERSION } from "../schema";

const BATCH_ROWS = 10_000;

// Rows are loaded into GTFS-shaped text tables, checked there, and only then
// derived into the layout in schema.sql
const STAGING_TABLES = `
  CREATE TABLE staging_agency (agency_id TEXT NOT NULL,
    agency_name TEXT NOT NULL, agency_url TEXT NOT NULL,
    agency_timezone TEXT NOT NULL);
  CREATE TABLE staging_routes (route_id TEXT NOT NULL, agency_id TEXT NOT NULL,
    route_short_name TEXT, route_long_name TEXT, route_desc TEXT,
    route_type INTEGER NOT NULL, route_url TEXT, route_color TEXT,
    route_text_color TEXT);
  CREATE TABLE staging_trips (trip_id TEXT NOT NULL, route_id TEXT NOT NULL,
    service_id TEXT NOT NULL, trip_headsign TEXT, trip_short_name TEXT,
    direction_id INTEGER, block_id TEXT, shape_id TEXT);
  CREATE TABLE staging_stops (stop_id TEXT NOT NULL, stop_code TEXT,
    stop_name TEXT NOT NULL, stop_desc TEXT, stop_lat REAL NOT NULL,
    stop_lon REAL NOT NULL, zone_id TEXT, stop_url TEXT,
    location_type INTEGER, parent_station TEXT, wheelchair_boarding INTEGER);
  CREATE TABLE staging_calendar (service_id TEXT NOT NULL,
    monday INTEGER NOT NULL, tuesday INTEGER NOT NULL,
    wednesday INTEGER NOT NULL, thursday INTEGER NOT NULL,
    friday INTEGER NOT NULL, saturday INTEGER NOT NULL,
    sunday INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL);
  CREATE TABLE staging_calendar_dates (service_id TEXT NOT NULL,
    date TEXT NOT NULL, exception_type INTEGER NOT NULL);
  CREATE TABLE staging_stop_times (trip_id TEXT NOT NULL,
    arrival_time INTEGER, departure_time INTEGER, stop_id TEXT NOT NULL,
    stop_sequence INTEGER NOT NULL, stop_headsign TEXT, pickup_type INTEGER,
    drop_off_type INTEGER, timepoint INTEGER);
  CREATE TABLE staging_feed_info (feed_version TEXT NOT NULL,
    feed_publisher_name TEXT NOT NULL, feed_publisher_url TEXT NOT NULL,
    feed_lang TEXT NOT NULL, feed_start_date TEXT, feed_end_date TEXT,
    feed_contact_email TEXT);
`;

// Added after loading, which is faster; fails on duplicate rows
const STAGING_KEYS = `
  CREATE UNIQUE INDEX staging_agency_pk ON staging_agency (agency_id);
  CREATE UNIQUE INDEX staging_routes_pk ON staging_routes (route_id);
  CREATE UNIQUE INDEX staging_trips_pk ON staging_trips (trip_id);
  CREATE UNIQUE INDEX staging_stops_pk ON staging_stops (stop_id);
  CREATE UNIQUE INDEX staging_calendar_pk ON staging_calendar (service_id);
  CREATE UNIQUE INDEX staging_calendar_dates_pk
    ON staging_calendar_dates (service_id, date);
  CREATE UNIQUE INDEX staging_stop_times_pk
    ON staging_stop_times (trip_id, stop_sequence);
`;

// Interns Trip, Stop, Route and Service IDs in GTFS ID order
const DERIVE = `
  INSERT INTO feed_info SELECT * FROM staging_feed_info;
  INSERT INTO agency SELECT * FROM staging_agency;
  INSERT INTO routes (route_id, agency_id, route_short_name, route_long_name,
    route_desc, route_type, route_url, route_color, route_text_color)
  SELECT * FROM staging_routes ORDER BY route_id;
  INSERT INTO services (service_id)
  SELECT service_id FROM staging_calendar
  UNION SELECT service_id FROM staging_calendar_dates
  ORDER BY service_id;
  INSERT INTO calendar
  SELECT s.id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
    start_date, end_date
  FROM staging_calendar JOIN services s USING (service_id);
  INSERT INTO calendar_dates
  SELECT s.id, date, exception_type
  FROM staging_calendar_dates JOIN services s USING (service_id);
  INSERT INTO trips (trip_id, route, service, trip_headsign, trip_short_name,
    direction_id, block_id, shape_id)
  SELECT t.trip_id, r.id, s.id, t.trip_headsign, t.trip_short_name,
    t.direction_id, t.block_id, t.shape_id
  FROM staging_trips t
  JOIN routes r USING (route_id)
  JOIN services s USING (service_id)
  ORDER BY t.trip_id;
  INSERT INTO stops (stop_id, stop_code, stop_name, stop_desc, stop_lat,
    stop_lon, zone_id, stop_url, location_type, parent_station,
    wheelchair_boarding)
  SELECT * FROM staging_stops ORDER BY stop_id;
  INSERT INTO stop_times
  SELECT s.id, st.departure_time, t.id, st.stop_sequence, st.stop_headsign,
    st.pickup_type
  FROM staging_stop_times st
  JOIN stops s USING (stop_id)
  JOIN trips t USING (trip_id)
  WHERE st.departure_time IS NOT NULL
  ORDER BY 1, 2, 3, 4;
`;

// Each table's columns in staging column order, so rows bind positionally
const COLUMNS: { [T in ScheduleTableName]: (keyof ScheduleTables[T])[] } = {
  agency: ["agencyId", "agencyName", "agencyUrl", "agencyTimezone"],
  routes: [
    "routeId",
    "agencyId",
    "routeShortName",
    "routeLongName",
    "routeDesc",
    "routeType",
    "routeUrl",
    "routeColor",
    "routeTextColor",
  ],
  trips: [
    "tripId",
    "routeId",
    "serviceId",
    "tripHeadsign",
    "tripShortName",
    "directionId",
    "blockId",
    "shapeId",
  ],
  stops: [
    "stopId",
    "stopCode",
    "stopName",
    "stopDesc",
    "stopLat",
    "stopLon",
    "zoneId",
    "stopUrl",
    "locationType",
    "parentStation",
    "wheelchairBoarding",
  ],
  calendar: [
    "serviceId",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "startDate",
    "endDate",
  ],
  calendar_dates: ["serviceId", "date", "exceptionType"],
  stop_times: [
    "tripId",
    "arrivalTime",
    "departureTime",
    "stopId",
    "stopSequence",
    "stopHeadsign",
    "pickupType",
    "dropOffType",
    "timepoint",
  ],
  feed_info: [
    "feedVersion",
    "feedPublisherName",
    "feedPublisherUrl",
    "feedLang",
    "feedStartDate",
    "feedEndDate",
    "feedContactEmail",
  ],
};

// Every field of every row type is listed, so none is dropped silently
const _columnsCoverRowTypes: {
  [T in ScheduleTableName]: Exclude<
    keyof ScheduleTables[T],
    (typeof COLUMNS)[T][number]
  > extends never
    ? true
    : false;
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

const snake = (key: string) =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Builds the Schedule as a SQLite file at `path`. The file is written beside
 * it and renamed into place once built, so `path` only ever holds a whole,
 * checked Schedule.
 */
export class SqliteScheduleImportRepository
  implements ScheduleImportRepository
{
  readonly schemaVersion = SCHEDULE_SCHEMA_VERSION;

  constructor(private readonly path: string) {
    this.path = path;
  }

  async createStaging(): Promise<ScheduleStaging> {
    const stagingPath = `${this.path}.staging`;
    const database = new DatabaseSync(stagingPath);
    try {
      // Held until the handle closes, or the process exits
      database.exec("PRAGMA locking_mode = EXCLUSIVE");
      try {
        database.exec("BEGIN EXCLUSIVE");
      } catch {
        throw new Error("Another Schedule Import is already running");
      }
      database.exec("COMMIT");
      // A build that crashes can be rerun from scratch, so nothing is
      // journaled. Temp storage on disk keeps sorts and VACUUM out of memory
      database.exec(`
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        PRAGMA temp_store = FILE;
        PRAGMA cache_size = -65536;
      `);
      dropAll(database);
      database.exec(STAGING_TABLES);
      return new SqliteScheduleStaging(database, stagingPath, this.path);
    } catch (error) {
      database.close();
      throw error;
    }
  }
}

class SqliteScheduleStaging implements ScheduleStaging {
  constructor(
    private readonly database: DatabaseSync,
    private readonly stagingPath: string,
    private readonly path: string,
  ) {
    this.database = database;
    this.stagingPath = stagingPath;
    this.path = path;
  }

  async load<T extends ScheduleTableName>(
    table: T,
    rows: AsyncIterable<ScheduleTables[T]>,
  ): Promise<number> {
    const keys = COLUMNS[table];
    const insert = this.database.prepare(
      `INSERT INTO staging_${table} (${keys.map((key) => snake(String(key))).join(", ")})
       VALUES (${keys.map(() => "?").join(", ")})`,
    );
    let count = 0;
    this.database.exec("BEGIN");
    try {
      for await (const row of rows) {
        insert.run(...keys.map((key) => bindable(row[key])));
        if (++count % BATCH_ROWS === 0) this.database.exec("COMMIT; BEGIN");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    return count;
  }

  async check(): Promise<string[]> {
    this.database.exec(STAGING_KEYS);

    const problems: string[] = [];
    for (const table of ["agency", "routes", "trips", "stops", "stop_times"]) {
      if (this.count(`SELECT 1 FROM staging_${table}`) === 0) {
        problems.push(`${table} is empty`);
      }
    }
    const feedInfo = this.count("SELECT 1 FROM staging_feed_info");
    if (feedInfo !== 1) {
      problems.push(`feed_info has ${feedInfo} rows, expected 1`);
    }

    const references: [string, string][] = [
      [
        "routes reference unknown agencies",
        `SELECT 1 FROM staging_routes r
         WHERE NOT EXISTS (SELECT 1 FROM staging_agency a WHERE a.agency_id = r.agency_id)`,
      ],
      [
        "trips reference unknown routes",
        `SELECT 1 FROM staging_trips t
         WHERE NOT EXISTS (SELECT 1 FROM staging_routes r WHERE r.route_id = t.route_id)`,
      ],
      [
        "trips reference unknown Service Calendars",
        `SELECT 1 FROM staging_trips t
         WHERE NOT EXISTS (SELECT 1 FROM staging_calendar c WHERE c.service_id = t.service_id)
           AND NOT EXISTS (SELECT 1 FROM staging_calendar_dates d WHERE d.service_id = t.service_id)`,
      ],
      [
        "stop_times reference unknown trips",
        `SELECT 1 FROM staging_stop_times st
         WHERE NOT EXISTS (SELECT 1 FROM staging_trips t WHERE t.trip_id = st.trip_id)`,
      ],
      [
        "stop_times reference unknown stops",
        `SELECT 1 FROM staging_stop_times st
         WHERE NOT EXISTS (SELECT 1 FROM staging_stops s WHERE s.stop_id = st.stop_id)`,
      ],
      [
        "stops reference unknown parent stations",
        `SELECT 1 FROM staging_stops s
         WHERE s.parent_station IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM staging_stops p WHERE p.stop_id = s.parent_station)`,
      ],
    ];
    for (const [problem, query] of references) {
      const count = this.count(query);
      if (count > 0) problems.push(`${count} ${problem}`);
    }
    return problems;
  }

  async build({ feedVersion, etag }: ScheduleImport): Promise<BuiltSchedule> {
    const { database } = this;
    database.exec(readScheduleSchema());
    database.exec("BEGIN");
    database.exec(DERIVE);
    database
      .prepare(
        "INSERT INTO schedule_import (feed_version, etag, imported_at) VALUES (?, ?, ?)",
      )
      .run(feedVersion, etag, new Date().toISOString());
    for (const table of Object.keys(COLUMNS)) {
      database.exec(`DROP TABLE staging_${table}`);
    }
    database.exec("COMMIT");
    database.exec("ANALYZE");
    // VACUUM's temp database copies the cache size, so release the cache the
    // load filled and shrink it first: this keeps about 75 MB off peak RSS
    database.exec("PRAGMA shrink_memory; PRAGMA cache_size = -8192");
    database.exec("VACUUM");
    // Still holding the lock, so no other import can touch the file first
    await rename(this.stagingPath, this.path);
    database.close();
    const { path } = this;
    const { size } = await stat(path);
    return { sizeBytes: size, read: () => createReadStream(path) };
  }

  async discard(): Promise<void> {
    if (this.database.isOpen) this.database.close();
    await rm(this.stagingPath, { force: true });
  }

  private count(query: string): number {
    const { count } = this.database
      .prepare(`SELECT count(*) AS count FROM (${query})`)
      .get() as { count: number };
    return count;
  }
}

/** Clears whatever a crashed build left in the staging file */
function dropAll(database: DatabaseSync) {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  for (const { name } of tables) database.exec(`DROP TABLE "${name}"`);
  database.exec("PRAGMA user_version = 0");
}

// node:sqlite can't bind booleans
function bindable(value: unknown): SQLInputValue {
  return typeof value === "boolean" ? Number(value) : (value as SQLInputValue);
}
