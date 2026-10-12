/** biome-ignore-all lint/suspicious/noConsole: spike output */
/**
 * Spike: build the Schedule as a SQLite file instead of loading Postgres.
 *
 * 1. Runs the real ScheduleImportService against the live feed, with a
 *    `node:sqlite` implementation of the ScheduleImportRepository port, so
 *    filtering and parsing are exactly what production does. Layout A mirrors
 *    the Postgres schema (text IDs, rowid tables, secondary indexes).
 * 2. Derives layout B from A inside SQLite: Trip, Stop, Route and Service IDs
 *    interned to integers, and stop_times as a WITHOUT ROWID table clustered
 *    on (stop_id, departure_time), so the Departures query reads one range.
 * 3. Reports build time, peak RSS, file and gzip sizes, and the latency of the
 *    Departures and nearby Stops queries on each layout.
 *
 * Usage: pnpm --filter @tfi-gtfs/schedule-sync spike:sqlite [url] [--keep] [--temp-memory]
 *   --keep         reuses layout A from a previous run instead of re-importing
 *   --temp-memory  keeps SQLite temp storage in memory instead of temp files
 */
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { GtfsStaticScheduleFeedClient } from "@tfi-gtfs/gtfs-static";
import {
  injectScheduleImportDependencies,
  type ScheduleImport,
  type ScheduleImportRepository,
  type ScheduleStaging,
  type ScheduleTableName,
  type ScheduleTables,
} from "@tfi-gtfs/tfi-gtfs-core";

const args = process.argv.slice(2);
const FEED_URL =
  args.find((a) => !a.startsWith("--")) ??
  "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip";
const KEEP = args.includes("--keep");
// Where sorts, index builds and VACUUM spill: MEMORY or FILE
const TEMP_STORE = args.includes("--temp-memory") ? "MEMORY" : "FILE";

const OUT_DIR = join(import.meta.dirname, "../.cache/sqlite-spike");
const TEXT_DB = join(OUT_DIR, "schedule-text.sqlite");
const INT_DB = join(OUT_DIR, "schedule-int.sqlite");

const BATCH_ROWS = 10_000;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// The kernel's high-water mark: a timer can't sample RSS while synchronous
// node:sqlite calls block the event loop
const peakRss = () => process.resourceUsage().maxRSS * 1024;

// --- Layout A: mirrors the Postgres schema ----------------------------------

const TEXT_SCHEMA = `
  CREATE TABLE agency (agency_id TEXT NOT NULL, agency_name TEXT NOT NULL,
    agency_url TEXT NOT NULL, agency_timezone TEXT NOT NULL);
  CREATE TABLE routes (route_id TEXT NOT NULL, agency_id TEXT NOT NULL,
    route_short_name TEXT, route_long_name TEXT, route_desc TEXT,
    route_type INTEGER NOT NULL, route_url TEXT, route_color TEXT,
    route_text_color TEXT);
  CREATE TABLE trips (trip_id TEXT NOT NULL, route_id TEXT NOT NULL,
    service_id TEXT NOT NULL, trip_headsign TEXT, trip_short_name TEXT,
    direction_id INTEGER, block_id TEXT, shape_id TEXT);
  CREATE TABLE stops (stop_id TEXT NOT NULL, stop_code TEXT,
    stop_name TEXT NOT NULL, stop_desc TEXT, stop_lat REAL NOT NULL,
    stop_lon REAL NOT NULL, zone_id TEXT, stop_url TEXT, location_type INTEGER,
    parent_station TEXT, wheelchair_boarding INTEGER);
  CREATE TABLE calendar (service_id TEXT NOT NULL, monday INTEGER NOT NULL,
    tuesday INTEGER NOT NULL, wednesday INTEGER NOT NULL,
    thursday INTEGER NOT NULL, friday INTEGER NOT NULL,
    saturday INTEGER NOT NULL, sunday INTEGER NOT NULL,
    start_date TEXT NOT NULL, end_date TEXT NOT NULL);
  CREATE TABLE calendar_dates (service_id TEXT NOT NULL, date TEXT NOT NULL,
    exception_type INTEGER NOT NULL);
  CREATE TABLE stop_times (trip_id TEXT NOT NULL, arrival_time INTEGER,
    departure_time INTEGER, stop_id TEXT NOT NULL,
    stop_sequence INTEGER NOT NULL, stop_headsign TEXT, pickup_type INTEGER,
    drop_off_type INTEGER, timepoint INTEGER);
  CREATE TABLE feed_info (feed_version TEXT NOT NULL,
    feed_publisher_name TEXT NOT NULL, feed_publisher_url TEXT NOT NULL,
    feed_lang TEXT NOT NULL, feed_start_date TEXT, feed_end_date TEXT,
    feed_contact_email TEXT);
  CREATE TABLE schedule_import (feed_version TEXT NOT NULL, etag TEXT,
    imported_at TEXT NOT NULL);
`;

// Added after the load, like the Postgres staging schema
const TEXT_INDEXES = `
  CREATE UNIQUE INDEX agency_pk ON agency (agency_id);
  CREATE UNIQUE INDEX routes_pk ON routes (route_id);
  CREATE UNIQUE INDEX trips_pk ON trips (trip_id);
  CREATE UNIQUE INDEX stops_pk ON stops (stop_id);
  CREATE INDEX stops_stop_lat_stop_lon_idx ON stops (stop_lat, stop_lon);
  CREATE UNIQUE INDEX calendar_pk ON calendar (service_id);
  CREATE UNIQUE INDEX calendar_dates_pk ON calendar_dates (service_id, date);
  CREATE UNIQUE INDEX stop_times_pk ON stop_times (trip_id, stop_sequence);
  CREATE INDEX stop_times_stop_id_departure_time_idx
    ON stop_times (stop_id, departure_time);
`;

const snake = (key: string) =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// node:sqlite can't bind booleans
const bindable = (value: unknown): SQLInputValue =>
  typeof value === "boolean" ? Number(value) : (value as SQLInputValue);

function openForBuild(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA cache_size = -65536;
    PRAGMA temp_store = ${TEMP_STORE};
  `);
  return db;
}

/** ScheduleImportRepository backed by a SQLite file that is swapped by rename */
class SqliteScheduleImportRepository implements ScheduleImportRepository {
  constructor(private readonly path: string) {
    this.path = path;
  }

  async findLatestImport(): Promise<ScheduleImport | null> {
    if (!existsSync(this.path)) return null;
    const db = new DatabaseSync(this.path, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT feed_version, etag FROM schedule_import ORDER BY imported_at DESC LIMIT 1",
        )
        .get() as { feed_version: string; etag: string | null } | undefined;
      return row
        ? {
            feedVersion: row.feed_version,
            etag: row.etag,
            watchedStopIds: null,
          }
        : null;
    } finally {
      db.close();
    }
  }

  async createStaging(): Promise<ScheduleStaging> {
    const stagingPath = `${this.path}.staging`;
    await rm(stagingPath, { force: true });
    const db = openForBuild(stagingPath);
    db.exec(TEXT_SCHEMA);
    const path = this.path;

    return {
      async load<T extends ScheduleTableName>(
        table: T,
        rows: AsyncIterable<ScheduleTables[T]>,
      ) {
        let insert: ReturnType<DatabaseSync["prepare"]> | null = null;
        let keys: string[] = [];
        let count = 0;
        db.exec("BEGIN");
        for await (const row of rows) {
          if (!insert) {
            keys = Object.keys(row);
            insert = db.prepare(
              `INSERT INTO ${table} (${keys.map(snake).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
            );
          }
          const record = row as Record<string, unknown>;
          insert.run(...keys.map((key) => bindable(record[key])));
          if (++count % BATCH_ROWS === 0) {
            db.exec("COMMIT; BEGIN");
          }
        }
        db.exec("COMMIT");
        return count;
      },

      async check() {
        // Throws on duplicate keys, as adding primary keys does in Postgres
        db.exec(TEXT_INDEXES);
        const orphans = (sql: string, what: string) => {
          const { n } = db.prepare(sql).get() as { n: number };
          return n > 0 ? [`${n} ${what}`] : [];
        };
        return [
          ...orphans(
            "SELECT count(*) n FROM stop_times WHERE trip_id NOT IN (SELECT trip_id FROM trips)",
            "Stop Times with an unknown Trip",
          ),
          ...orphans(
            "SELECT count(*) n FROM stop_times WHERE stop_id NOT IN (SELECT stop_id FROM stops)",
            "Stop Times with an unknown Stop",
          ),
          ...orphans(
            "SELECT count(*) n FROM trips WHERE route_id NOT IN (SELECT route_id FROM routes)",
            "Trips with an unknown Route",
          ),
        ];
      },

      async publish({ feedVersion, etag }) {
        db.prepare(
          "INSERT INTO schedule_import (feed_version, etag, imported_at) VALUES (?, ?, ?)",
        ).run(feedVersion, etag, new Date().toISOString());
        db.exec("ANALYZE");
        db.close();
        await rename(stagingPath, path);
      },

      async discard() {
        db.close();
        await rm(stagingPath, { force: true });
      },
    };
  }
}

// --- Layout B: interned integer IDs, stop_times clustered by Stop -----------

function buildIntLayout(textPath: string, intPath: string) {
  const db = openForBuild(intPath);
  db.exec(`ATTACH DATABASE '${textPath}' AS src`);
  db.exec(`
    BEGIN;
    CREATE TABLE agency AS SELECT * FROM src.agency;
    CREATE TABLE feed_info AS SELECT * FROM src.feed_info;
    CREATE TABLE schedule_import AS SELECT * FROM src.schedule_import;

    CREATE TABLE routes (id INTEGER PRIMARY KEY, route_id TEXT NOT NULL UNIQUE,
      agency_id TEXT NOT NULL, route_short_name TEXT, route_long_name TEXT,
      route_type INTEGER NOT NULL, route_color TEXT, route_text_color TEXT);
    INSERT INTO routes (route_id, agency_id, route_short_name, route_long_name,
      route_type, route_color, route_text_color)
    SELECT route_id, agency_id, route_short_name, route_long_name, route_type,
      route_color, route_text_color FROM src.routes ORDER BY route_id;

    CREATE TABLE services (id INTEGER PRIMARY KEY, service_id TEXT NOT NULL UNIQUE);
    INSERT INTO services (service_id)
    SELECT service_id FROM src.calendar UNION SELECT service_id FROM src.calendar_dates
    UNION SELECT service_id FROM src.trips;

    CREATE TABLE calendar (service INTEGER PRIMARY KEY, monday INTEGER NOT NULL,
      tuesday INTEGER NOT NULL, wednesday INTEGER NOT NULL,
      thursday INTEGER NOT NULL, friday INTEGER NOT NULL,
      saturday INTEGER NOT NULL, sunday INTEGER NOT NULL,
      start_date TEXT NOT NULL, end_date TEXT NOT NULL);
    INSERT INTO calendar SELECT s.id, monday, tuesday, wednesday, thursday,
      friday, saturday, sunday, start_date, end_date
    FROM src.calendar c JOIN services s USING (service_id);

    CREATE TABLE calendar_dates (service INTEGER NOT NULL, date TEXT NOT NULL,
      exception_type INTEGER NOT NULL, PRIMARY KEY (service, date)) WITHOUT ROWID;
    INSERT INTO calendar_dates SELECT s.id, date, exception_type
    FROM src.calendar_dates c JOIN services s USING (service_id);

    CREATE TABLE trips (id INTEGER PRIMARY KEY, trip_id TEXT NOT NULL UNIQUE,
      route INTEGER NOT NULL, service INTEGER NOT NULL, trip_headsign TEXT,
      direction_id INTEGER, shape_id TEXT);
    INSERT INTO trips (trip_id, route, service, trip_headsign, direction_id, shape_id)
    SELECT t.trip_id, r.id, s.id, t.trip_headsign, t.direction_id, t.shape_id
    FROM src.trips t JOIN routes r USING (route_id) JOIN services s USING (service_id)
    ORDER BY t.trip_id;

    CREATE TABLE stops (id INTEGER PRIMARY KEY, stop_id TEXT NOT NULL UNIQUE,
      stop_code TEXT, stop_name TEXT NOT NULL, stop_desc TEXT,
      stop_lat REAL NOT NULL, stop_lon REAL NOT NULL, zone_id TEXT,
      location_type INTEGER, parent_station TEXT, wheelchair_boarding INTEGER);
    INSERT INTO stops (stop_id, stop_code, stop_name, stop_desc, stop_lat,
      stop_lon, zone_id, location_type, parent_station, wheelchair_boarding)
    SELECT stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon,
      zone_id, location_type, parent_station, wheelchair_boarding
    FROM src.stops ORDER BY stop_id;
    CREATE INDEX stops_stop_lat_stop_lon_idx ON stops (stop_lat, stop_lon);

    -- Only what Departures need; the key makes it a covering, clustered index
    CREATE TABLE stop_times (stop INTEGER NOT NULL, departure_time INTEGER NOT NULL,
      trip INTEGER NOT NULL, stop_sequence INTEGER NOT NULL, stop_headsign TEXT,
      pickup_type INTEGER,
      PRIMARY KEY (stop, departure_time, trip, stop_sequence)) WITHOUT ROWID;
    INSERT INTO stop_times
    SELECT s.id, st.departure_time, t.id, st.stop_sequence, st.stop_headsign,
      st.pickup_type
    FROM src.stop_times st JOIN stops s USING (stop_id) JOIN trips t USING (trip_id)
    WHERE st.departure_time IS NOT NULL
    ORDER BY 1, 2, 3, 4;
    COMMIT;
  `);
  db.exec("DETACH DATABASE src");
  db.exec("ANALYZE");
  db.exec("VACUUM");
  db.close();
}

// --- Queries ----------------------------------------------------------------

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const weekday = (serviceDate: string) =>
  WEEKDAYS[new Date(serviceDate).getUTCDay()] ?? "sunday";

// The same shape as DepartureRepositoryImpl.findScheduledStopTimes
const textDeparturesSql = (serviceDate: string) => `
  SELECT st.trip_id, st.stop_id, st.stop_sequence, st.departure_time,
    coalesce(st.stop_headsign, t.trip_headsign) AS headsign, t.direction_id,
    r.route_id, r.route_short_name, r.route_long_name, r.route_type, r.agency_id
  FROM stop_times st
  JOIN trips t ON t.trip_id = st.trip_id
  JOIN routes r ON r.route_id = t.route_id
  WHERE st.stop_id = :stopId
    AND st.departure_time BETWEEN :fromTime AND :toTime
    AND (st.pickup_type IS NULL OR st.pickup_type <> 1)
    AND ((EXISTS (SELECT 1 FROM calendar c WHERE c.service_id = t.service_id
            AND c.${weekday(serviceDate)} = 1
            AND :serviceDate BETWEEN c.start_date AND c.end_date)
          AND NOT EXISTS (SELECT 1 FROM calendar_dates cd
            WHERE cd.service_id = t.service_id AND cd.date = :serviceDate
            AND cd.exception_type = 2))
      OR EXISTS (SELECT 1 FROM calendar_dates cd
            WHERE cd.service_id = t.service_id AND cd.date = :serviceDate
            AND cd.exception_type = 1))
  ORDER BY st.departure_time, st.trip_id
  LIMIT :limit`;

const intDeparturesSql = (serviceDate: string) => `
  SELECT t.trip_id, s.stop_id, st.stop_sequence, st.departure_time,
    coalesce(st.stop_headsign, t.trip_headsign) AS headsign, t.direction_id,
    r.route_id, r.route_short_name, r.route_long_name, r.route_type, r.agency_id
  FROM stops s
  JOIN stop_times st ON st.stop = s.id
  JOIN trips t ON t.id = st.trip
  JOIN routes r ON r.id = t.route
  WHERE s.stop_id = :stopId
    AND st.departure_time BETWEEN :fromTime AND :toTime
    AND (st.pickup_type IS NULL OR st.pickup_type <> 1)
    AND ((EXISTS (SELECT 1 FROM calendar c WHERE c.service = t.service
            AND c.${weekday(serviceDate)} = 1
            AND :serviceDate BETWEEN c.start_date AND c.end_date)
          AND NOT EXISTS (SELECT 1 FROM calendar_dates cd
            WHERE cd.service = t.service AND cd.date = :serviceDate
            AND cd.exception_type = 2))
      OR EXISTS (SELECT 1 FROM calendar_dates cd
            WHERE cd.service = t.service AND cd.date = :serviceDate
            AND cd.exception_type = 1))
  ORDER BY st.departure_time, t.trip_id
  LIMIT :limit`;

const EARTH_RADIUS_METRES = 6_371_008.8;
const METRES_PER_DEGREE_LAT = (Math.PI * EARTH_RADIUS_METRES) / 180;

const nearbySql = `
  SELECT * FROM (
    SELECT stop_id, stop_name, 2 * ${EARTH_RADIUS_METRES} * asin(min(1, sqrt(
      pow(sin(radians(stop_lat - :lat) / 2), 2)
      + cos(radians(:lat)) * cos(radians(stop_lat))
      * pow(sin(radians(stop_lon - :lon) / 2), 2)))) AS distance
    FROM stops
    WHERE stop_lat BETWEEN :minLat AND :maxLat
      AND stop_lon BETWEEN :minLon AND :maxLon
      AND (location_type IS NULL OR location_type = 0)
  ) WHERE distance <= :radius
  ORDER BY distance, stop_id
  LIMIT :limit`;

function timeQuery(run: () => unknown[], iterations: number) {
  const first = performance.now();
  const rows = run();
  const coldMs = performance.now() - first;
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const pct = (p: number) =>
    samples[Math.min(samples.length - 1, Math.floor(p * samples.length))] ?? 0;
  return { rows: rows.length, coldMs, p50: pct(0.5), p99: pct(0.99) };
}

function benchmark(
  label: string,
  path: string,
  departuresSql: typeof textDeparturesSql,
) {
  // A fresh connection per layout; the OS page cache is warm from building it
  const db = new DatabaseSync(path, { readOnly: true });
  const busiest = db
    .prepare(
      path === TEXT_DB
        ? "SELECT stop_id, count(*) n FROM stop_times GROUP BY stop_id ORDER BY n DESC LIMIT 1"
        : "SELECT s.stop_id, count(*) n FROM stop_times st JOIN stops s ON s.id = st.stop GROUP BY st.stop ORDER BY n DESC LIMIT 1",
    )
    .get() as { stop_id: string; n: number };
  const serviceDate = new Date().toISOString().slice(0, 10);

  // getByStop runs this for three Service Days; one is representative
  const departures = db.prepare(departuresSql(serviceDate));
  const morningPeak = { fromTime: 8 * 3600, toTime: 8 * 3600 + 24 * 3600 };
  const dep = timeQuery(
    () =>
      departures.all({
        stopId: busiest.stop_id,
        serviceDate,
        ...morningPeak,
        limit: 20,
      }),
    200,
  );

  // O'Connell Street, 500 m
  const lat = 53.3498;
  const lon = -6.2603;
  const radius = 500;
  const latDelta = radius / METRES_PER_DEGREE_LAT;
  const lonDelta =
    radius / (METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  const nearby = db.prepare(nearbySql);
  const near = timeQuery(
    () =>
      nearby.all({
        lat,
        lon,
        radius,
        minLat: lat - latDelta,
        maxLat: lat + latDelta,
        minLon: lon - lonDelta,
        maxLon: lon + lonDelta,
        limit: 20,
      }),
    200,
  );
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${departuresSql(serviceDate)}`)
    .all({ stopId: busiest.stop_id, serviceDate, ...morningPeak, limit: 20 })
    .map((row) => `      ${(row as { detail: string }).detail}`)
    .join("\n");
  db.close();

  const ms = (n: number) => `${n.toFixed(2)}ms`;
  console.log(`\n${label}`);
  console.log(
    `  Departures at busiest Stop ${busiest.stop_id} (${busiest.n} Stop Times) on ${serviceDate}: ${dep.rows} rows, cold ${ms(dep.coldMs)}, p50 ${ms(dep.p50)}, p99 ${ms(dep.p99)}`,
  );
  console.log(`    plan:\n${plan}`);
  console.log(
    `  Nearby Stops (500 m, O'Connell St): ${near.rows} rows, cold ${ms(near.coldMs)}, p50 ${ms(near.p50)}, p99 ${ms(near.p99)}`,
  );
}

async function gzipSize(path: string) {
  let bytes = 0;
  await pipeline(
    createReadStream(path),
    createGzip({ level: 6 }),
    async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) bytes += chunk.length;
    },
  );
  return bytes;
}

async function tableSizes(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT name, sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC",
      )
      .all() as { name: string; bytes: number }[];
  } catch {
    return []; // dbstat isn't compiled in
  } finally {
    db.close();
  }
}

// --- main -------------------------------------------------------------------

await mkdir(OUT_DIR, { recursive: true });
console.log(`Feed:   ${FEED_URL}`);
console.log(`Output: ${OUT_DIR}\n`);

if (!(KEEP && existsSync(TEXT_DB))) {
  await rm(TEXT_DB, { force: true });
  const { scheduleImportService } = injectScheduleImportDependencies(
    new GtfsStaticScheduleFeedClient(FEED_URL),
    new SqliteScheduleImportRepository(TEXT_DB),
  );
  const started = performance.now();
  const result = await scheduleImportService.importSchedule();
  console.log(
    `Layout A (text IDs) imported ${result.feedVersion} in ${secs(performance.now() - started)}, peak RSS ${mb(peakRss())}`,
  );
  if (result.status === "imported") console.table(result.rowCounts);
}

{
  await rm(INT_DB, { force: true });
  const started = performance.now();
  buildIntLayout(TEXT_DB, INT_DB);
  console.log(
    `Layout B (integer IDs) derived in ${secs(performance.now() - started)}, peak RSS ${mb(peakRss())}`,
  );
}

console.log("\nSizes (file / gzip -6):");
for (const [label, path] of [
  ["A text IDs", TEXT_DB],
  ["B integer IDs", INT_DB],
] as const) {
  const { size } = await stat(path);
  console.log(
    `  ${label.padEnd(14)} ${mb(size).padStart(10)} / ${mb(await gzipSize(path)).padStart(10)}`,
  );
  for (const { name, bytes } of (await tableSizes(path)).slice(0, 6)) {
    console.log(`      ${name.padEnd(40)} ${mb(bytes).padStart(10)}`);
  }
}

benchmark("Layout A (text IDs)", TEXT_DB, textDeparturesSql);
benchmark("Layout B (integer IDs)", INT_DB, intDeparturesSql);

console.log(`\nPeak RSS overall: ${mb(peakRss())}`);
