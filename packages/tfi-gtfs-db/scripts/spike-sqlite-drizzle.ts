/** biome-ignore-all lint/suspicious/noConsole: spike output */
/**
 * PROTOTYPE, throwaway. Answers "Does the SQLite read path still hold up
 * behind Drizzle?" (https://github.com/conor-ob/tfi-gtfs/issues/51).
 *
 * Re-runs the server side of ADR 0006 (apps/server/scripts/spike-sqlite-swap.ts)
 * with Departures and Nearby Stops written in Drizzle, on `node:sqlite` behind
 * `drizzle-orm/sqlite-proxy` (the driver chosen in issue 48):
 *
 * 1. Publishes the integer-ID file (built by `pnpm --filter
 *    @tfi-gtfs/schedule-sync spike:sqlite`) to a local HTTP stand-in for the
 *    bucket, then downloads, hash-checks and opens it read-only.
 * 2. Times Departures at the busiest Stop and Nearby Stops, raw `node:sqlite`
 *    against Drizzle, in the same process, and checks they return the same rows.
 * 3. Runs Drizzle Departures at every Stop and reports RSS.
 * 4. Hot-swaps Feed Versions under a Drizzle query loop.
 *
 * Usage: node packages/tfi-gtfs-db/scripts/spike-sqlite-drizzle.ts [path-to-int.sqlite]
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { createGunzip, createGzip } from "node:zlib";
import {
  and,
  asc,
  between,
  eq,
  exists,
  getTableColumns,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";

const SOURCE_DB =
  process.argv[2] ??
  join(
    import.meta.dirname,
    "../../../jobs/schedule-sync/.cache/sqlite-spike/schedule-int.sqlite",
  );
const OUT_DIR = join(import.meta.dirname, "../.cache/sqlite-drizzle-spike");
const BUCKET_DIR = join(OUT_DIR, "bucket");
const DISK_DIR = join(OUT_DIR, "disk");
const PREFIX = "schedule/v1";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const ms = (n: number) => `${n.toFixed(3)}ms`;
const memory = () => {
  const { rss, heapUsed } = process.memoryUsage();
  return `rss ${mb(rss)}, heap ${mb(heapUsed)}, peak rss ${mb(process.resourceUsage().maxRSS * 1024)}`;
};

// --- The integer-ID layout, in sqlite-core ----------------------------------
// Drizzle 0.45 can't say WITHOUT ROWID; for reads it doesn't need to. The
// composite primaryKey documents the clustering the file was built with.

const routes = sqliteTable("routes", {
  id: integer("id").primaryKey(),
  routeId: text("route_id").notNull().unique(),
  agencyId: text("agency_id").notNull(),
  routeShortName: text("route_short_name"),
  routeLongName: text("route_long_name"),
  routeType: integer("route_type").notNull(),
  routeColor: text("route_color"),
  routeTextColor: text("route_text_color"),
});

const calendar = sqliteTable("calendar", {
  service: integer("service").primaryKey(),
  monday: integer("monday", { mode: "boolean" }).notNull(),
  tuesday: integer("tuesday", { mode: "boolean" }).notNull(),
  wednesday: integer("wednesday", { mode: "boolean" }).notNull(),
  thursday: integer("thursday", { mode: "boolean" }).notNull(),
  friday: integer("friday", { mode: "boolean" }).notNull(),
  saturday: integer("saturday", { mode: "boolean" }).notNull(),
  sunday: integer("sunday", { mode: "boolean" }).notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
});

const calendarDates = sqliteTable(
  "calendar_dates",
  {
    service: integer("service").notNull(),
    date: text("date").notNull(),
    exceptionType: integer("exception_type").notNull(),
  },
  (t) => [primaryKey({ columns: [t.service, t.date] })],
);

const trips = sqliteTable("trips", {
  id: integer("id").primaryKey(),
  tripId: text("trip_id").notNull().unique(),
  route: integer("route").notNull(),
  service: integer("service").notNull(),
  tripHeadsign: text("trip_headsign"),
  directionId: integer("direction_id"),
  shapeId: text("shape_id"),
});

const stops = sqliteTable(
  "stops",
  {
    id: integer("id").primaryKey(),
    stopId: text("stop_id").notNull().unique(),
    stopCode: text("stop_code"),
    stopName: text("stop_name").notNull(),
    stopDesc: text("stop_desc"),
    stopLat: real("stop_lat").notNull(),
    stopLon: real("stop_lon").notNull(),
    zoneId: text("zone_id"),
    locationType: integer("location_type"),
    parentStation: text("parent_station"),
    wheelchairBoarding: integer("wheelchair_boarding"),
  },
  (t) => [index("stops_stop_lat_stop_lon_idx").on(t.stopLat, t.stopLon)],
);

const stopTimes = sqliteTable(
  "stop_times",
  {
    stop: integer("stop").notNull(),
    departureTime: integer("departure_time").notNull(),
    trip: integer("trip").notNull(),
    stopSequence: integer("stop_sequence").notNull(),
    stopHeadsign: text("stop_headsign"),
    pickupType: integer("pickup_type"),
  },
  (t) => [
    primaryKey({
      columns: [t.stop, t.departureTime, t.trip, t.stopSequence],
    }),
  ],
);

const feedInfo = sqliteTable("feed_info", {
  feedVersion: text("feed_version").notNull(),
});

// --- Swappable handle behind sqlite-proxy -----------------------------------

type Pointer = { key: string; feedVersion: string; sha256: string };
type Open = {
  db: DatabaseSync;
  path: string;
  pointer: Pointer;
  statements: Map<string, StatementSync>;
};

let open: Open | null = null;

function statement(sqlText: string) {
  if (!open) throw new Error("Schedule not loaded");
  let stmt = open.statements.get(sqlText);
  if (!stmt) {
    stmt = open.db.prepare(sqlText);
    stmt.setReturnArrays(true);
    open.statements.set(sqlText, stmt);
  }
  return stmt;
}

// The callback reads `open` on every call, so a swap is one assignment
const db = drizzle(async (sqlText, params, method) => {
  const stmt = statement(sqlText);
  const args = params as (string | number | null)[];
  if (method === "run") {
    stmt.run(...args);
    return { rows: [] };
  }
  if (method === "get") return { rows: stmt.get(...args) as unknown as [] };
  return { rows: stmt.all(...args) as unknown as [] };
});

/** The raw handle for the baseline, not cached by sqlite-proxy's callback */
function raw(sqlText: string) {
  if (!open) throw new Error("Schedule not loaded");
  return open.db.prepare(sqlText);
}

// --- Fake bucket (as in spike-sqlite-swap.ts) -------------------------------

function tap(onChunk: (chunk: Buffer) => void) {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      onChunk(chunk);
      done(null, chunk);
    },
  });
}

async function publish(sourcePath: string, feedVersion: string) {
  const key = `${PREFIX}/${feedVersion}.sqlite.gz`;
  await mkdir(join(BUCKET_DIR, PREFIX), { recursive: true });
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(sourcePath),
    createGzip({ level: 6 }),
    tap((chunk) => hash.update(chunk)),
    createWriteStream(join(BUCKET_DIR, key)),
  );
  const pointerPath = join(BUCKET_DIR, PREFIX, "latest.json");
  await writeFile(
    `${pointerPath}.tmp`,
    JSON.stringify({ key, feedVersion, sha256: hash.digest("hex") }),
  );
  await rename(`${pointerPath}.tmp`, pointerPath);
}

function serveBucket() {
  const server = createServer((req, res) => {
    const path = join(BUCKET_DIR, decodeURIComponent(req.url ?? "/"));
    if (!path.startsWith(BUCKET_DIR) || !existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200);
    createReadStream(path).pipe(res);
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

async function refresh(bucketUrl: string) {
  const pointer = (await (
    await fetch(`${bucketUrl}/${PREFIX}/latest.json`)
  ).json()) as Pointer;
  if (pointer.key === open?.pointer.key) return null;
  const started = performance.now();
  const response = await fetch(`${bucketUrl}/${pointer.key}`);
  const path = join(DISK_DIR, `${pointer.feedVersion}.sqlite`);
  const partial = `${path}.partial`;
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    tap((chunk) => hash.update(chunk)),
    createGunzip(),
    createWriteStream(partial),
  );
  if (hash.digest("hex") !== pointer.sha256) throw new Error("sha256 mismatch");
  await rename(partial, path);
  const downloadMs = performance.now() - started;
  const previous = open;
  open = {
    db: new DatabaseSync(path, { readOnly: true }),
    path,
    pointer,
    statements: new Map(),
  };
  if (previous) {
    previous.db.close();
    await rm(previous.path, { force: true });
  }
  return downloadMs;
}

// --- Departures -------------------------------------------------------------

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const ADDED = 1;
const REMOVED = 2;
const NO_PICKUP = 1;

const serviceDate = new Date().toISOString().slice(0, 10);
const now = new Date();
const fromTime = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60;
const toTime = fromTime + 24 * 3600;
const LIMIT = 20;

/** The production DepartureRepository query, joined through integer IDs */
function departuresQuery(stopId: string | ReturnType<typeof sql.placeholder>) {
  const weekday = WEEKDAYS[new Date(serviceDate).getUTCDay()] ?? "sunday";
  const exception = (exceptionType: number) =>
    db
      .select({ one: sql`1` })
      .from(calendarDates)
      .where(
        and(
          eq(calendarDates.service, trips.service),
          eq(calendarDates.date, serviceDate),
          eq(calendarDates.exceptionType, exceptionType),
        ),
      );
  const regular = db
    .select({ one: sql`1` })
    .from(calendar)
    .where(
      and(
        eq(calendar.service, trips.service),
        eq(calendar[weekday], true),
        sql`${serviceDate} between ${calendar.startDate} and ${calendar.endDate}`,
      ),
    );
  return db
    .select({
      tripId: trips.tripId,
      stopId: stops.stopId,
      stopSequence: stopTimes.stopSequence,
      departureTime: stopTimes.departureTime,
      headsign: sql<
        string | null
      >`coalesce(${stopTimes.stopHeadsign}, ${trips.tripHeadsign})`,
      directionId: trips.directionId,
      routeId: routes.routeId,
      routeShortName: routes.routeShortName,
      routeLongName: routes.routeLongName,
      routeColor: routes.routeColor,
      routeTextColor: routes.routeTextColor,
      routeType: routes.routeType,
      agencyId: routes.agencyId,
    })
    .from(stops)
    .innerJoin(stopTimes, eq(stopTimes.stop, stops.id))
    .innerJoin(trips, eq(trips.id, stopTimes.trip))
    .innerJoin(routes, eq(routes.id, trips.route))
    .where(
      and(
        eq(stops.stopId, stopId as string),
        between(stopTimes.departureTime, fromTime, toTime),
        or(isNull(stopTimes.pickupType), ne(stopTimes.pickupType, NO_PICKUP)),
        or(
          and(exists(regular), notExists(exception(REMOVED))),
          exists(exception(ADDED)),
        ),
      ),
    )
    .orderBy(asc(stopTimes.departureTime), asc(trips.tripId))
    .limit(LIMIT);
}

function drizzleDepartures(stopId: string) {
  return departuresQuery(stopId);
}

// Built once; sqlite-proxy's callback reads the current handle, so it should
// survive a swap
const preparedDepartures = departuresQuery(sql.placeholder("stopId")).prepare();

const rawDeparturesSql = `
  SELECT t.trip_id AS tripId, s.stop_id AS stopId, st.stop_sequence AS stopSequence,
    st.departure_time AS departureTime,
    coalesce(st.stop_headsign, t.trip_headsign) AS headsign,
    t.direction_id AS directionId, r.route_id AS routeId,
    r.route_short_name AS routeShortName, r.route_long_name AS routeLongName,
    r.route_color AS routeColor, r.route_text_color AS routeTextColor,
    r.route_type AS routeType, r.agency_id AS agencyId
  FROM stops s
  JOIN stop_times st ON st.stop = s.id
  JOIN trips t ON t.id = st.trip
  JOIN routes r ON r.id = t.route
  WHERE s.stop_id = :stopId
    AND st.departure_time BETWEEN :fromTime AND :toTime
    AND (st.pickup_type IS NULL OR st.pickup_type <> 1)
    AND ((EXISTS (SELECT 1 FROM calendar c WHERE c.service = t.service
            AND c.${WEEKDAYS[new Date(serviceDate).getUTCDay()] ?? "sunday"} = 1
            AND :serviceDate BETWEEN c.start_date AND c.end_date)
          AND NOT EXISTS (SELECT 1 FROM calendar_dates cd
            WHERE cd.service = t.service AND cd.date = :serviceDate
            AND cd.exception_type = 2))
      OR EXISTS (SELECT 1 FROM calendar_dates cd
            WHERE cd.service = t.service AND cd.date = :serviceDate
            AND cd.exception_type = 1))
  ORDER BY st.departure_time, t.trip_id
  LIMIT ${LIMIT}`;

function rawDepartures(stopId: string) {
  return raw(rawDeparturesSql).all({
    stopId,
    serviceDate,
    fromTime,
    toTime,
  });
}

// --- Nearby Stops -----------------------------------------------------------

const EARTH_RADIUS_METRES = 6_371_008.8;
const METRES_PER_DEGREE_LAT = (Math.PI * EARTH_RADIUS_METRES) / 180;

/** The production StopRepository query, with SQLite's min() for least() */
function drizzleNearby(lat: number, lon: number, radius: number) {
  const latDelta = radius / METRES_PER_DEGREE_LAT;
  const lonDelta =
    radius / (METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  const distance = sql<number>`2 * ${EARTH_RADIUS_METRES} * asin(min(1, sqrt(
    pow(sin(radians(${stops.stopLat} - ${lat}) / 2), 2)
    + cos(radians(${lat})) * cos(radians(${stops.stopLat}))
    * pow(sin(radians(${stops.stopLon} - ${lon}) / 2), 2)
  )))`;
  return db
    .select({ ...getTableColumns(stops), distance: distance.as("distance") })
    .from(stops)
    .where(
      and(
        between(stops.stopLat, lat - latDelta, lat + latDelta),
        between(stops.stopLon, lon - lonDelta, lon + lonDelta),
        or(isNull(stops.locationType), eq(stops.locationType, 0)),
        lte(distance, radius),
      ),
    )
    .orderBy(sql`distance`, asc(stops.stopId))
    .limit(LIMIT);
}

function rawNearby(lat: number, lon: number, radius: number) {
  const latDelta = radius / METRES_PER_DEGREE_LAT;
  const lonDelta =
    radius / (METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  return raw(`
    SELECT * FROM (
      SELECT *, 2 * ${EARTH_RADIUS_METRES} * asin(min(1, sqrt(
        pow(sin(radians(stop_lat - :lat) / 2), 2)
        + cos(radians(:lat)) * cos(radians(stop_lat))
        * pow(sin(radians(stop_lon - :lon) / 2), 2)))) AS distance
      FROM stops
      WHERE stop_lat BETWEEN :minLat AND :maxLat
        AND stop_lon BETWEEN :minLon AND :maxLon
        AND (location_type IS NULL OR location_type = 0)
    ) WHERE distance <= :radius
    ORDER BY distance, stop_id
    LIMIT ${LIMIT}`).all({
    lat,
    lon,
    radius,
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  });
}

// --- Timing -----------------------------------------------------------------

async function time(run: () => unknown, iterations: number) {
  for (let i = 0; i < 50; i++) await run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const at = (p: number) => samples[Math.floor((samples.length - 1) * p)] ?? 0;
  return `p50 ${ms(at(0.5))}, p99 ${ms(at(0.99))}`;
}

// --- main -------------------------------------------------------------------

if (!existsSync(SOURCE_DB)) {
  console.error(
    `${SOURCE_DB} not found; run pnpm --filter @tfi-gtfs/schedule-sync spike:sqlite first`,
  );
  process.exit(1);
}
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(DISK_DIR, { recursive: true });
console.log(`Baseline:            ${memory()}`);

const sourceV2 = join(OUT_DIR, "v2.sqlite");
await copyFile(SOURCE_DB, sourceV2);
{
  const v2 = new DatabaseSync(sourceV2);
  v2.exec("UPDATE feed_info SET feed_version = feed_version || '-v2'");
  v2.close();
}
const source = new DatabaseSync(SOURCE_DB, { readOnly: true });
const { feed_version: feedVersion } = source
  .prepare("SELECT feed_version FROM feed_info")
  .get() as { feed_version: string };
source.close();

await publish(SOURCE_DB, feedVersion);
const bucket = await serveBucket();
console.log(
  `Startup download:    ${ms((await refresh(bucket.url)) ?? 0)} for ${feedVersion}`,
);
console.log(`After open:          ${memory()}`);

const stopIds = (await db.select({ stopId: stops.stopId }).from(stops)).map(
  (row) => row.stopId,
);
const [busiest] = raw(`
  SELECT s.stop_id AS stopId, count(*) AS n FROM stop_times st
  JOIN stops s ON s.id = st.stop GROUP BY st.stop ORDER BY n DESC LIMIT 1`).all() as {
  stopId: string;
  n: number;
}[];
const busiestStop = busiest?.stopId ?? "";
console.log(
  `Busiest Stop:        ${busiestStop} (${busiest?.n} Stop Times), ${stopIds.length} Stops`,
);

// Same rows from both paths, at every Stop
{
  let mismatches = 0;
  let rows = 0;
  for (const stopId of stopIds) {
    const a = JSON.stringify(rawDepartures(stopId));
    const b = JSON.stringify(await drizzleDepartures(stopId));
    rows += (await drizzleDepartures(stopId)).length;
    if (a !== b) {
      if (mismatches === 0) console.log("first mismatch", stopId, a, b);
      mismatches++;
    }
  }
  console.log(
    `Departures parity:   ${mismatches} mismatches over ${stopIds.length} Stops, ${rows} rows`,
  );
}

console.log(
  `Departures raw:      ${await time(() => rawDepartures(busiestStop), 2000)}`,
);
console.log(
  `Departures Drizzle:  ${await time(() => drizzleDepartures(busiestStop), 2000)}`,
);

console.log(
  `Departures prepared: ${await time(() => preparedDepartures.all({ stopId: busiestStop }), 2000)}`,
);

// O'Connell Street
const [lat, lon, radius] = [53.3498, -6.2603, 500];
{
  const a = rawNearby(lat, lon, radius) as Record<string, unknown>[];
  const b = await drizzleNearby(lat, lon, radius);
  console.log(
    `Nearby parity:       raw ${a.map((r) => r.stop_id).join(",") === b.map((r) => r.stopId).join(",") ? "=" : "≠"} Drizzle, ${b.length} Stops`,
  );
}
console.log(
  `Nearby raw:          ${await time(() => rawNearby(lat, lon, radius), 2000)}`,
);
console.log(
  `Nearby Drizzle:      ${await time(() => drizzleNearby(lat, lon, radius), 2000)}`,
);

{
  const started = performance.now();
  let rows = 0;
  for (const stopId of stopIds)
    rows += (await drizzleDepartures(stopId)).length;
  const elapsed = performance.now() - started;
  console.log(
    `All Stops, Drizzle:  ${rows} Departures in ${ms(elapsed)} (${ms(elapsed / stopIds.length)} each)`,
  );
  console.log(`After all Stops:     ${memory()}`);
}

// Hot swap under a Drizzle query loop
{
  const seen: string[] = [];
  let queries = 0;
  let errors = 0;
  let slowest = 0;
  let running = true;
  const loop = async () => {
    let i = 0;
    while (running) {
      const started = performance.now();
      try {
        const stopId = stopIds[i++ % stopIds.length] ?? "";
        const a = JSON.stringify(await drizzleDepartures(stopId));
        const b = JSON.stringify(await preparedDepartures.all({ stopId }));
        if (a !== b) throw new Error(`prepared query diverged at ${stopId}`);
        const [row] = await db.select().from(feedInfo).limit(1);
        if (row && seen.at(-1) !== row.feedVersion) seen.push(row.feedVersion);
        queries++;
      } catch (error) {
        errors++;
        if (errors === 1) console.error("query failed:", error);
      }
      slowest = Math.max(slowest, performance.now() - started);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const lag = monitorEventLoopDelay({ resolution: 1 });
  const traffic = loop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await publish(sourceV2, `${feedVersion}-v2`);
  lag.enable();
  const downloadMs = await refresh(bucket.url);
  lag.disable();
  await new Promise((resolve) => setTimeout(resolve, 200));
  running = false;
  await traffic;
  console.log(
    `Swap download:       ${ms(downloadMs ?? 0)}; event-loop delay p50 ${ms(lag.percentile(50) / 1e6)}, p99 ${ms(lag.percentile(99) / 1e6)}, max ${ms(lag.max / 1e6)}`,
  );
  console.log(
    `Queries during swap: ${queries}, errors ${errors}, slowest ${ms(slowest)}, Feed Versions seen: ${seen.join(" → ")}`,
  );
  console.log(`Files on disk after: ${(await readdir(DISK_DIR)).join(", ")}`);
  console.log(`After swap:          ${memory()}`);
}

open?.db.close();
bucket.close();
