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

export class ScheduleImportError extends Error {
  constructor(problems: string[]) {
    super(`Schedule failed checks:\n- ${problems.join("\n- ")}`);
    this.name = "ScheduleImportError";
  }
}

export type ScheduleImportOptions = {
  /**
   * The only Stops to import Departures for (see
   * docs/adr/0007-import-only-watched-stops.md). Null or empty keeps every
   * Stop.
   */
  watchedStopIds: readonly string[] | null;
};

export class ScheduleImportServiceImpl implements ScheduleImportService {
  private readonly watchedStopIds: string[] | null;

  constructor(
    private readonly scheduleFeedClient: ScheduleFeedClient,
    private readonly scheduleImportRepository: ScheduleImportRepository,
    options: Partial<ScheduleImportOptions> = {},
  ) {
    this.scheduleFeedClient = scheduleFeedClient;
    this.scheduleImportRepository = scheduleImportRepository;
    const ids = options.watchedStopIds ?? [];
    this.watchedStopIds = ids.length > 0 ? [...new Set(ids)].sort() : null;
  }

  async importSchedule(): Promise<ScheduleImportResult> {
    const feed = await this.scheduleFeedClient.open();
    const feedInfo = await first(feed.read("feed_info"));
    if (!feedInfo) throw new Error("Schedule has no feed_info row");
    const { feedVersion } = feedInfo;

    const { watchedStopIds } = this;
    const latest = await this.scheduleImportRepository.findLatestImport();
    if (
      latest?.feedVersion === feedVersion &&
      latest.etag === feed.etag &&
      sameStops(latest.watchedStopIds, watchedStopIds)
    ) {
      return { status: "skipped", feedVersion };
    }

    const staging = await this.scheduleImportRepository.createStaging();
    try {
      const { rowCounts, unknownWatchedStopIds } = await loadSchedule(
        feed,
        staging,
        watchedStopIds ? new Set(watchedStopIds) : null,
      );
      const problems = await staging.check();
      if (problems.length > 0) throw new ScheduleImportError(problems);
      await staging.publish({ feedVersion, etag: feed.etag, watchedStopIds });
      return {
        status: "imported",
        feedVersion,
        rowCounts,
        unknownWatchedStopIds,
      };
    } catch (error) {
      await staging.discard();
      throw error;
    }
  }
}

/**
 * Loads the rows reachable from the Watched Stops, or from every Stop when
 * none are set. Routes and Trips are held back until Stop Times have
 * streamed, so only those serving a kept Stop Time are written; Agencies,
 * Service Calendars and Stops follow from them.
 */
async function loadSchedule(
  feed: ScheduleFeed,
  staging: ScheduleStaging,
  watchedStopIds: Set<string> | null,
) {
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
      if (watchedStopIds && !watchedStopIds.has(row.stopId)) return false;
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
  const allStops = await collect(feed.read("stops"));
  const stops = await staging.load("stops", keptStops(allStops, stopIds));
  const feedInfo = await staging.load("feed_info", feed.read("feed_info"));

  const knownStopIds = new Set(allStops.map((stop) => stop.stopId));
  return {
    rowCounts: {
      agency,
      routes,
      trips,
      calendar,
      calendar_dates: calendarDates,
      stop_times: stopTimes,
      stops,
      feed_info: feedInfo,
    } satisfies Record<ScheduleTableName, number>,
    unknownWatchedStopIds: [...(watchedStopIds ?? [])].filter(
      (stopId) => !knownStopIds.has(stopId),
    ),
  };
}

function sameStops(a: string[] | null, b: string[] | null) {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((stopId, i) => stopId === b[i]);
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
