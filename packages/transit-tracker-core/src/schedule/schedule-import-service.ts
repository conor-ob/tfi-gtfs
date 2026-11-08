import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type {
  Route,
  ScheduleImportResult,
  ScheduleTableName,
  Stop,
  Trip,
} from "./domain/types";
import type { ScheduleImportService } from "./interfaces/inbound/schedule-import-service";
import type {
  ScheduleFeed,
  ScheduleFeedClient,
} from "./interfaces/outbound/schedule-feed-client";
import type {
  ScheduleImportRepository,
  ScheduleStaging,
} from "./interfaces/outbound/schedule-import-repository";
import type { ScheduleStore } from "./interfaces/outbound/schedule-store";
import { publishSchedule } from "./schedule-publication";

export class ScheduleImportError extends Error {
  constructor(problems: string[]) {
    super(`Schedule failed checks:\n- ${problems.join("\n- ")}`);
    this.name = "ScheduleImportError";
  }
}

/**
 * Builds the whole Schedule as a file and publishes it to the
 * `ScheduleStore` (see
 * docs/adr/0011-full-schedule-served-from-sqlite-file-in-bucket.md). The
 * pointer is written last, so a failed import leaves it where it was.
 */
export class ScheduleImportServiceImpl implements ScheduleImportService {
  constructor(
    private readonly scheduleFeedClient: ScheduleFeedClient,
    private readonly scheduleImportRepository: ScheduleImportRepository,
    private readonly scheduleStore: ScheduleStore,
  ) {
    this.scheduleFeedClient = scheduleFeedClient;
    this.scheduleImportRepository = scheduleImportRepository;
    this.scheduleStore = scheduleStore;
  }

  async importSchedule(): Promise<ScheduleImportResult> {
    const feed = await this.scheduleFeedClient.open();
    const feedInfo = await first(feed.read("feed_info"));
    if (!feedInfo) throw new Error("Schedule has no feed_info row");
    const { feedVersion } = feedInfo;
    const { etag } = feed;
    const { schemaVersion } = this.scheduleImportRepository;

    const latest = await this.scheduleStore.getPointer(schemaVersion);
    if (latest?.feedVersion === feedVersion && latest.etag === etag) {
      return { status: "skipped", feedVersion, key: latest.key };
    }

    const staging = await this.scheduleImportRepository.createStaging();
    try {
      const rowCounts = await loadSchedule(feed, staging);
      const problems = await staging.check();
      if (problems.length > 0) throw new ScheduleImportError(problems);
      const file = await staging.build({ feedVersion, etag });
      let gzipBytes = 0;
      const { key } = await publishSchedule(this.scheduleStore, {
        schemaVersion,
        feedVersion,
        etag,
        body: tap(gzip(file.read()), (chunk) => {
          gzipBytes += chunk.byteLength;
        }),
      });
      return {
        status: "imported",
        feedVersion,
        key,
        rowCounts,
        sizeBytes: file.sizeBytes,
        gzipBytes,
      };
    } catch (error) {
      await staging.discard();
      throw error;
    }
  }
}

/**
 * Loads every Stop Time and what it reaches. Routes and Trips are held back
 * until Stop Times have streamed, so only those serving a Stop Time are
 * written; Agencies, Service Calendars and Stops follow from them.
 */
async function loadSchedule(
  feed: ScheduleFeed,
  staging: ScheduleStaging,
): Promise<Record<ScheduleTableName, number>> {
  const routesById = new Map<string, Route>();
  for await (const route of feed.read("routes")) {
    routesById.set(route.routeId, route);
  }
  const tripsById = new Map<string, Trip>();
  for await (const trip of feed.read("trips")) {
    if (routesById.has(trip.routeId)) tripsById.set(trip.tripId, trip);
  }

  const tripIds = new Set<string>();
  const stopIds = new Set<string>();
  const stopTimes = await staging.load(
    "stop_times",
    filter(feed.read("stop_times"), (row) => {
      if (!tripsById.has(row.tripId)) return false;
      tripIds.add(row.tripId);
      stopIds.add(row.stopId);
      return true;
    }),
  );

  const routeIds = new Set<string>();
  const serviceIds = new Set<string>();
  const trips = await staging.load(
    "trips",
    filter(tripsById.values(), (row) => {
      if (!tripIds.has(row.tripId)) return false;
      routeIds.add(row.routeId);
      serviceIds.add(row.serviceId);
      return true;
    }),
  );
  tripsById.clear();
  const agencyIds = new Set<string>();
  const routes = await staging.load(
    "routes",
    filter(routesById.values(), (row) => {
      if (!routeIds.has(row.routeId)) return false;
      agencyIds.add(row.agencyId);
      return true;
    }),
  );
  const agency = await staging.load(
    "agency",
    filter(feed.read("agency"), (row) => agencyIds.has(row.agencyId)),
  );
  const calendar = await staging.load(
    "calendar",
    filter(feed.read("calendar"), (row) => serviceIds.has(row.serviceId)),
  );
  const calendarDates = await staging.load(
    "calendar_dates",
    filter(feed.read("calendar_dates"), (row) => serviceIds.has(row.serviceId)),
  );
  const stops = await staging.load(
    "stops",
    keptStops(await collect(feed.read("stops")), stopIds),
  );
  const feedInfo = await staging.load("feed_info", feed.read("feed_info"));

  return {
    agency,
    routes,
    trips,
    calendar,
    calendar_dates: calendarDates,
    stop_times: stopTimes,
    stops,
    feed_info: feedInfo,
  };
}

/** Stops served by a kept Trip, plus the Stations that contain them */
async function* keptStops(stops: Stop[], servedStopIds: Set<string>) {
  const byId = new Map(stops.map((stop) => [stop.stopId, stop]));
  const kept = new Set<string>();
  for (const stopId of servedStopIds) {
    let id: string | null = stopId;
    while (id && !kept.has(id)) {
      kept.add(id);
      id = byId.get(id)?.parentStation ?? null;
    }
  }
  for (const stop of stops) {
    if (kept.has(stop.stopId)) yield stop;
  }
}

async function* filter<T>(
  rows: AsyncIterable<T> | Iterable<T>,
  keep: (row: T) => boolean,
): AsyncIterable<T> {
  for await (const row of rows) {
    if (keep(row)) yield row;
  }
}

async function first<T>(rows: AsyncIterable<T>): Promise<T | undefined> {
  for await (const row of rows) return row;
  return undefined;
}

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const row of rows) all.push(row);
  return all;
}

async function* tap<T>(
  items: AsyncIterable<T>,
  see: (item: T) => void,
): AsyncIterable<T> {
  for await (const item of items) {
    see(item);
    yield item;
  }
}

async function* gzip(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const gzipped = createGzip();
  const piped = pipeline(Readable.from(chunks), gzipped);
  // A failure also ends the loop below, which rethrows it
  piped.catch(() => {});
  yield* gzipped;
  await piped;
}
