import type {
  ScheduleImportResult,
  ScheduleTableName,
  Stop,
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

// Agencies whose Trips the Realtime Feed covers (see
// docs/adr/0001-nta-realtime-schedule-filtered-by-agency.md)
const KEPT_AGENCY_IDS = new Set(["1", "3", "03C", "10000", "IR"]);

export class ScheduleImportError extends Error {
  constructor(problems: string[]) {
    super(`Schedule failed checks:\n- ${problems.join("\n- ")}`);
    this.name = "ScheduleImportError";
  }
}

export class ScheduleImportServiceImpl implements ScheduleImportService {
  constructor(
    private readonly scheduleFeedClient: ScheduleFeedClient,
    private readonly scheduleImportRepository: ScheduleImportRepository,
  ) {
    this.scheduleFeedClient = scheduleFeedClient;
    this.scheduleImportRepository = scheduleImportRepository;
  }

  async importSchedule(): Promise<ScheduleImportResult> {
    const feed = await this.scheduleFeedClient.open();
    const feedInfo = await first(feed.read("feed_info"));
    if (!feedInfo) throw new Error("Schedule has no feed_info row");
    const { feedVersion } = feedInfo;

    const latest = await this.scheduleImportRepository.findLatestImport();
    if (latest?.feedVersion === feedVersion && latest.etag === feed.etag) {
      return { status: "skipped", feedVersion };
    }

    const staging = await this.scheduleImportRepository.createStaging();
    try {
      const rowCounts = await loadSchedule(feed, staging);
      const problems = await staging.check();
      if (problems.length > 0) throw new ScheduleImportError(problems);
      await staging.publish({ feedVersion, etag: feed.etag });
      return { status: "imported", feedVersion, rowCounts };
    } catch (error) {
      await staging.discard();
      throw error;
    }
  }
}

/**
 * Loads entries in dependency order, keeping only rows reachable from the kept
 * Agencies: Routes → Trips → Service Calendars and Stop Times → Stops.
 */
async function loadSchedule(feed: ScheduleFeed, staging: ScheduleStaging) {
  const routeIds = new Set<string>();
  const tripIds = new Set<string>();
  const serviceIds = new Set<string>();
  const stopIds = new Set<string>();

  const agency = await staging.load(
    "agency",
    filter(feed.read("agency"), (row) => KEPT_AGENCY_IDS.has(row.agencyId)),
  );
  const routes = await staging.load(
    "routes",
    filter(feed.read("routes"), (row) => {
      if (!KEPT_AGENCY_IDS.has(row.agencyId)) return false;
      routeIds.add(row.routeId);
      return true;
    }),
  );
  const trips = await staging.load(
    "trips",
    filter(feed.read("trips"), (row) => {
      if (!routeIds.has(row.routeId)) return false;
      tripIds.add(row.tripId);
      serviceIds.add(row.serviceId);
      return true;
    }),
  );
  const calendar = await staging.load(
    "calendar",
    filter(feed.read("calendar"), (row) => serviceIds.has(row.serviceId)),
  );
  const calendarDates = await staging.load(
    "calendar_dates",
    filter(feed.read("calendar_dates"), (row) => serviceIds.has(row.serviceId)),
  );
  const stopTimes = await staging.load(
    "stop_times",
    filter(feed.read("stop_times"), (row) => {
      if (!tripIds.has(row.tripId)) return false;
      stopIds.add(row.stopId);
      return true;
    }),
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
  } satisfies Record<ScheduleTableName, number>;
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
  rows: AsyncIterable<T>,
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
