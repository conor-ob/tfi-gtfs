/** biome-ignore-all lint/suspicious/noConsole: spike output */
/**
 * Spike: the server side of docs/adr/0006-schedule-served-from-sqlite-file.md.
 *
 * 1. Publishes two Feed Versions of an integer-ID Schedule file (built by
 *    `SqliteScheduleImportRepository` in `tfi-gtfs-sqlite`) to a local HTTP
 *    server that stands in for the Railway Storage Bucket: gzipped objects
 *    plus a `latest.json` pointer.
 * 2. Startup: reads the pointer, streams the object through a SHA-256 check
 *    and gunzip to disk, opens it read-only.
 * 3. Queries Departures at every Stop, so the whole file has been read, and
 *    reports RSS before and after.
 * 4. Hot swap: keeps a query loop running while the pointer moves to the
 *    second Feed Version, then reports what the loop saw: errors, the slowest
 *    query, event-loop delay during the download, and which Feed Version
 *    answered before and after.
 *
 * Usage: pnpm --filter @tfi-gtfs/server spike:sqlite-swap <path-to-schedule.sqlite>
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
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

const SOURCE_DB = process.argv[2];
if (!SOURCE_DB) {
  console.error("Usage: spike:sqlite-swap <path-to-schedule.sqlite>");
  process.exit(1);
}
const OUT_DIR = join(import.meta.dirname, "../.cache/sqlite-swap-spike");
const BUCKET_DIR = join(OUT_DIR, "bucket");
const DISK_DIR = join(OUT_DIR, "disk");
const SCHEMA_VERSION = 1;
const PREFIX = `schedule/v${SCHEMA_VERSION}`;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const ms = (n: number) => `${n.toFixed(2)}ms`;
const memory = () => {
  const { rss, heapUsed, external } = process.memoryUsage();
  return `rss ${mb(rss)}, heap ${mb(heapUsed)}, external ${mb(external)}, peak rss ${mb(process.resourceUsage().maxRSS * 1024)}`;
};

type Pointer = {
  key: string;
  feedVersion: string;
  sha256: string;
  importedAt: string;
};

// --- Fake bucket ------------------------------------------------------------

/** What the job does after building a file: upload the object, then the pointer */
async function publish(sourcePath: string, feedVersion: string) {
  const key = `${PREFIX}/${feedVersion}.sqlite.gz`;
  const objectPath = join(BUCKET_DIR, key);
  await mkdir(join(BUCKET_DIR, PREFIX), { recursive: true });
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(sourcePath),
    createGzip({ level: 6 }),
    tap((chunk) => hash.update(chunk)),
    createWriteStream(objectPath),
  );
  const pointer: Pointer = {
    key,
    feedVersion,
    sha256: hash.digest("hex"),
    importedAt: new Date().toISOString(),
  };
  // Write then rename, as an S3 PUT replaces an object whole
  const pointerPath = join(BUCKET_DIR, PREFIX, "latest.json");
  await writeFile(`${pointerPath}.tmp`, JSON.stringify(pointer));
  await rename(`${pointerPath}.tmp`, pointerPath);
  return pointer;
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

function tap(onChunk: (chunk: Buffer) => void) {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      onChunk(chunk);
      done(null, chunk);
    },
  });
}

// --- What the server would run ----------------------------------------------

type OpenSchedule = {
  db: DatabaseSync;
  path: string;
  pointer: Pointer;
  statements: Map<string, StatementSync>;
};

/**
 * Holds the open Schedule file and replaces it when the bucket's pointer
 * moves. Queries always go through `current`, so a swap is one assignment;
 * node:sqlite is synchronous, so no query is in flight while it happens.
 */
class ScheduleFile {
  private open: OpenSchedule | null = null;

  constructor(
    private readonly bucketUrl: string,
    private readonly dir: string,
  ) {
    this.bucketUrl = bucketUrl;
    this.dir = dir;
  }

  get current(): OpenSchedule {
    if (!this.open) throw new Error("Schedule not loaded");
    return this.open;
  }

  /** Statements are prepared per file, since they belong to one connection */
  prepare(sql: string): StatementSync {
    const { db, statements } = this.current;
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  /** Returns how long the download took, or null when nothing changed */
  async refresh(): Promise<{ downloadMs: number; bytes: number } | null> {
    const response = await fetch(`${this.bucketUrl}/${PREFIX}/latest.json`);
    if (!response.ok) throw new Error(`pointer: HTTP ${response.status}`);
    const pointer = (await response.json()) as Pointer;
    if (pointer.key === this.open?.pointer.key) return null;

    const started = performance.now();
    const path = join(this.dir, `${pointer.feedVersion}.sqlite`);
    const bytes = await download(
      `${this.bucketUrl}/${pointer.key}`,
      path,
      pointer.sha256,
    );
    const downloadMs = performance.now() - started;

    const db = new DatabaseSync(path, { readOnly: true });
    const previous = this.open;
    this.open = { db, path, pointer, statements: new Map() };
    if (previous) {
      previous.db.close();
      await rm(previous.path, { force: true });
    }
    return { downloadMs, bytes };
  }

  close() {
    this.open?.db.close();
    this.open = null;
  }
}

/** Streams a gzipped object to `path`, verifying its hash before the rename */
async function download(url: string, path: string, sha256: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const partial = `${path}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      tap((chunk) => {
        hash.update(chunk);
        bytes += chunk.length;
      }),
      createGunzip(),
      createWriteStream(partial),
    );
    const actual = hash.digest("hex");
    if (actual !== sha256)
      throw new Error(`${url}: sha256 ${actual}, expected ${sha256}`);
    await rename(partial, path);
    return bytes;
  } finally {
    await rm(partial, { force: true });
  }
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

const departuresSql = (serviceDate: string) => `
  SELECT t.trip_id, st.stop_sequence, st.departure_time,
    coalesce(st.stop_headsign, t.trip_headsign) AS headsign, t.direction_id,
    r.route_id, r.route_short_name, r.route_type, r.agency_id
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
  LIMIT 20`;

const serviceDate = new Date().toISOString().slice(0, 10);
const now = new Date();
const secondsToday = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60;

function departuresAt(schedule: ScheduleFile, stopId: string) {
  return schedule.prepare(departuresSql(serviceDate)).all({
    stopId,
    serviceDate,
    fromTime: secondsToday,
    toTime: secondsToday + 24 * 3600,
  });
}

// --- main -------------------------------------------------------------------

if (!existsSync(SOURCE_DB)) {
  console.error(`${SOURCE_DB} not found`);
  process.exit(1);
}
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(DISK_DIR, { recursive: true });

console.log(`Baseline:           ${memory()}`);

// Two Feed Versions, differing only in feed_info
const sourceV2 = join(OUT_DIR, "v2.sqlite");
await copyFile(SOURCE_DB, sourceV2);
{
  const db = new DatabaseSync(sourceV2);
  db.exec("UPDATE feed_info SET feed_version = feed_version || '-v2'");
  db.close();
}
const v1 = new DatabaseSync(SOURCE_DB, { readOnly: true });
const { feed_version: feedVersion } = v1
  .prepare("SELECT feed_version FROM feed_info")
  .get() as { feed_version: string };
const stopIds = (
  v1.prepare("SELECT stop_id FROM stops").all() as { stop_id: string }[]
).map((row) => row.stop_id);
v1.close();

await publish(SOURCE_DB, feedVersion);
const bucket = await serveBucket();

// Startup
const schedule = new ScheduleFile(bucket.url, DISK_DIR);
{
  const result = await schedule.refresh();
  console.log(
    `Startup download:   ${mb(result?.bytes ?? 0)} gzipped in ${ms(result?.downloadMs ?? 0)}`,
  );
  console.log(`After open:         ${memory()}`);
}

// Every Stop once, so every page of stop_times has been read
{
  const started = performance.now();
  let rows = 0;
  for (const stopId of stopIds) rows += departuresAt(schedule, stopId).length;
  const elapsed = performance.now() - started;
  console.log(
    `All ${stopIds.length} Stops:      ${rows} Departures in ${ms(elapsed)} (${ms(elapsed / stopIds.length)} each)`,
  );
  console.log(`After all Stops:    ${memory()}`);
}

// Hot swap under load
{
  const versionOf = () =>
    (
      schedule.prepare("SELECT feed_version FROM feed_info").get() as {
        feed_version: string;
      }
    ).feed_version;
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
        departuresAt(schedule, stopIds[i++ % stopIds.length] ?? "");
        const version = versionOf();
        if (seen.at(-1) !== version) seen.push(version);
        queries++;
      } catch (error) {
        errors++;
        if (errors === 1) console.error("query failed:", error);
      }
      slowest = Math.max(slowest, performance.now() - started);
      // Yield so the download makes progress, as request handling would
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const lag = monitorEventLoopDelay({ resolution: 1 });
  const traffic = loop();
  await new Promise((resolve) => setTimeout(resolve, 200));

  await publish(sourceV2, `${feedVersion}-v2`);
  lag.enable();
  const result = await schedule.refresh();
  lag.disable();
  await new Promise((resolve) => setTimeout(resolve, 200));
  running = false;
  await traffic;

  console.log(
    `Swap download:      ${mb(result?.bytes ?? 0)} gzipped in ${ms(result?.downloadMs ?? 0)}; event-loop delay during it p50 ${ms(lag.percentile(50) / 1e6)}, p99 ${ms(lag.percentile(99) / 1e6)}, max ${ms(lag.max / 1e6)}`,
  );
  console.log(
    `Queries during swap: ${queries}, errors ${errors}, slowest ${ms(slowest)}, Feed Versions seen in order: ${seen.join(" → ")}`,
  );
  console.log(
    `Files on disk after: ${(await import("node:fs/promises").then((fs) => fs.readdir(DISK_DIR))).join(", ")}`,
  );
  console.log(`After swap:         ${memory()}`);
}

// A corrupted object must be rejected and leave the current file serving
{
  const pointerPath = join(BUCKET_DIR, PREFIX, "latest.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Pointer;
  await writeFile(
    pointerPath,
    JSON.stringify({ ...pointer, key: `${PREFIX}/${feedVersion}.sqlite.gz` }),
  );
  try {
    await schedule.refresh();
    console.log("Corrupt object:     accepted (unexpected)");
  } catch (error) {
    console.log(
      `Corrupt object:     rejected (${(error as Error).message.split(": ").at(-1)}); still serving ${schedule.current.pointer.feedVersion}`,
    );
  }
}

schedule.close();
bucket.close();
