import { describe, expect, it } from "vitest";
import type {
  Agency,
  FeedInfo,
  Route,
  ScheduleImport,
  ScheduleTableName,
  ScheduleTables,
  ServiceCalendar,
  ServiceCalendarDate,
  Stop,
  StopTime,
  Trip,
} from "./domain/types";
import type { ScheduleFeedClient } from "./interfaces/outbound/schedule-feed-client";
import type {
  ScheduleImportRepository,
  ScheduleStaging,
} from "./interfaces/outbound/schedule-import-repository";
import { ScheduleImportServiceImpl } from "./schedule-import-service";

type Rows = { [T in ScheduleTableName]: ScheduleTables[T][] };

const agency = (agencyId: string): Agency => ({
  agencyId,
  agencyName: agencyId,
  agencyUrl: "https://example.ie",
  agencyTimezone: "Europe/Dublin",
});

const route = (routeId: string, agencyId: string): Route => ({
  routeId,
  agencyId,
  routeShortName: routeId,
  routeLongName: null,
  routeDesc: null,
  routeType: 3,
  routeUrl: null,
  routeColor: null,
  routeTextColor: null,
});

const trip = (tripId: string, routeId: string, serviceId: string): Trip => ({
  tripId,
  routeId,
  serviceId,
  tripHeadsign: null,
  tripShortName: null,
  directionId: 0,
  blockId: null,
  shapeId: null,
});

const stop = (stopId: string, parentStation: string | null = null): Stop => ({
  stopId,
  stopCode: null,
  stopName: stopId,
  stopDesc: null,
  stopLat: 53.35,
  stopLon: -6.26,
  zoneId: null,
  stopUrl: null,
  locationType: null,
  parentStation,
  wheelchairBoarding: null,
});

const calendar = (serviceId: string): ServiceCalendar => ({
  serviceId,
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
  startDate: "2026-10-10",
  endDate: "2027-10-10",
});

const calendarDate = (serviceId: string): ServiceCalendarDate => ({
  serviceId,
  date: "2026-10-26",
  exceptionType: 2,
});

const stopTime = (tripId: string, stopId: string, seq: number): StopTime => ({
  tripId,
  arrivalTime: 25_200 + seq * 60,
  departureTime: 25_200 + seq * 60,
  stopId,
  stopSequence: seq,
  stopHeadsign: null,
  pickupType: 0,
  dropOffType: 0,
  timepoint: 1,
});

const feedInfo: FeedInfo = {
  feedVersion: "v2",
  feedPublisherName: "National Transport Authority",
  feedPublisherUrl: "https://www.nationaltransport.ie/",
  feedLang: "en",
  feedStartDate: "2026-10-10",
  feedEndDate: "2027-10-10",
  feedContactEmail: null,
};

// Agency 9 runs no Routes. Trip t3 has no Stop Times, route r39 only runs at
// s2, and Bus Éireann's (2) r101 only runs at s3.
function feedRows(): Rows {
  return {
    agency: [agency("1"), agency("2"), agency("9")],
    routes: [route("r46a", "1"), route("r39", "1"), route("r101", "2")],
    trips: [
      trip("t1", "r46a", "weekday"),
      trip("t2", "r101", "other"),
      trip("t3", "r46a", "empty"),
      trip("t4", "r39", "weekend"),
    ],
    calendar: [
      calendar("weekday"),
      calendar("other"),
      calendar("empty"),
      calendar("weekend"),
    ],
    calendar_dates: [calendarDate("weekday"), calendarDate("other")],
    stop_times: [
      stopTime("t1", "s1", 1),
      stopTime("t1", "s2", 2),
      stopTime("t2", "s3", 1),
      stopTime("t4", "s2", 1),
    ],
    stops: [
      stop("station"),
      stop("s1", "station"),
      stop("s2"),
      stop("s3"),
      stop("unused"),
    ],
    feed_info: [feedInfo],
  };
}

function fakeClient(rows: Rows, etag = "etag-2"): ScheduleFeedClient {
  return {
    async open() {
      return {
        etag,
        async *read(table) {
          yield* rows[table];
        },
      };
    },
  };
}

class FakeStaging implements ScheduleStaging {
  loaded: Partial<Rows> = {};
  problems: string[] = [];
  published: ScheduleImport | null = null;
  discarded = false;

  async load<T extends ScheduleTableName>(
    table: T,
    rows: AsyncIterable<ScheduleTables[T]>,
  ) {
    const all: ScheduleTables[T][] = [];
    for await (const row of rows) all.push(row);
    (this.loaded as Record<string, unknown[]>)[table] = all;
    return all.length;
  }

  async check() {
    return this.problems;
  }

  async publish(scheduleImport: ScheduleImport) {
    this.published = scheduleImport;
  }

  async discard() {
    this.discarded = true;
  }
}

function fakeRepository(
  staging: FakeStaging,
  latest: ScheduleImport | null = null,
): ScheduleImportRepository {
  return {
    findLatestImport: async () => latest,
    createStaging: async () => staging,
  };
}

describe("ScheduleImportServiceImpl", () => {
  it("loads every Stop and what its Trips reference", async () => {
    const staging = new FakeStaging();
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows()),
      fakeRepository(staging),
    );

    const result = await service.importSchedule();

    const ids = <T>(rows: T[] | undefined, key: keyof T) =>
      rows?.map((row) => row[key]);
    // Agency 9 runs no kept Route, so it is dropped
    expect(ids(staging.loaded.agency, "agencyId")).toEqual(["1", "2"]);
    expect(ids(staging.loaded.routes, "routeId")).toEqual([
      "r46a",
      "r39",
      "r101",
    ]);
    // t3 has no Stop Times, so neither it nor its Service Calendar is kept
    expect(ids(staging.loaded.trips, "tripId")).toEqual(["t1", "t2", "t4"]);
    expect(ids(staging.loaded.calendar, "serviceId")).toEqual([
      "weekday",
      "other",
      "weekend",
    ]);
    expect(ids(staging.loaded.calendar_dates, "serviceId")).toEqual([
      "weekday",
      "other",
    ]);
    expect(ids(staging.loaded.stop_times, "stopId")).toEqual([
      "s1",
      "s2",
      "s3",
      "s2",
    ]);
    // s1's parent Station is kept even though no Trip stops at it directly
    expect(ids(staging.loaded.stops, "stopId")).toEqual([
      "station",
      "s1",
      "s2",
      "s3",
    ]);
    expect(staging.loaded.feed_info).toEqual([feedInfo]);
    expect(staging.published).toEqual({
      feedVersion: "v2",
      etag: "etag-2",
      watchedStopIds: null,
    });
    expect(result).toEqual({
      status: "imported",
      feedVersion: "v2",
      rowCounts: {
        agency: 2,
        routes: 3,
        trips: 3,
        calendar: 3,
        calendar_dates: 2,
        stop_times: 4,
        stops: 4,
        feed_info: 1,
      },
      unknownWatchedStopIds: [],
    });
  });

  it("loads only the Watched Stops and the Trips that serve them", async () => {
    const staging = new FakeStaging();
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows()),
      fakeRepository(staging),
      { watchedStopIds: ["s2", "s3", "missing", "s2"] },
    );

    const result = await service.importSchedule();

    const ids = <T>(rows: T[] | undefined, key: keyof T) =>
      rows?.map((row) => row[key]);
    // s1 isn't watched, but t1 still serves s2; Bus Éireann's t2 serves s3
    expect(ids(staging.loaded.stop_times, "tripId")).toEqual([
      "t1",
      "t2",
      "t4",
    ]);
    expect(ids(staging.loaded.trips, "tripId")).toEqual(["t1", "t2", "t4"]);
    expect(ids(staging.loaded.routes, "routeId")).toEqual([
      "r46a",
      "r39",
      "r101",
    ]);
    expect(ids(staging.loaded.agency, "agencyId")).toEqual(["1", "2"]);
    expect(ids(staging.loaded.stops, "stopId")).toEqual(["s2", "s3"]);
    expect(staging.published?.watchedStopIds).toEqual(["missing", "s2", "s3"]);
    expect(result).toMatchObject({ unknownWatchedStopIds: ["missing"] });
  });

  it("skips the import when the feed is unchanged", async () => {
    const staging = new FakeStaging();
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows()),
      fakeRepository(staging, {
        feedVersion: "v2",
        etag: "etag-2",
        watchedStopIds: null,
      }),
    );

    const result = await service.importSchedule();

    expect(result).toEqual({ status: "skipped", feedVersion: "v2" });
    expect(staging.loaded).toEqual({});
  });

  it("skips the import when the Watched Stops are the same in any order", async () => {
    const staging = new FakeStaging();
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows()),
      fakeRepository(staging, {
        feedVersion: "v2",
        etag: "etag-2",
        watchedStopIds: ["s1", "s2"],
      }),
      { watchedStopIds: ["s2", "s1"] },
    );

    const result = await service.importSchedule();

    expect(result.status).toBe("skipped");
  });

  it.each([
    { previous: null, current: ["s1"] },
    { previous: ["s1"], current: [] },
    { previous: ["s1"], current: ["s1", "s2"] },
  ])(
    "imports when the Watched Stops changed from $previous to $current",
    async ({ previous, current }) => {
      const staging = new FakeStaging();
      const service = new ScheduleImportServiceImpl(
        fakeClient(feedRows()),
        fakeRepository(staging, {
          feedVersion: "v2",
          etag: "etag-2",
          watchedStopIds: previous,
        }),
        { watchedStopIds: current },
      );

      const result = await service.importSchedule();

      expect(result.status).toBe("imported");
    },
  );

  it("imports when only the ETag changed", async () => {
    const staging = new FakeStaging();
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows(), "etag-3"),
      fakeRepository(staging, {
        feedVersion: "v2",
        etag: "etag-2",
        watchedStopIds: null,
      }),
    );

    const result = await service.importSchedule();

    expect(result.status).toBe("imported");
  });

  it("discards staging and does not publish when checks find problems", async () => {
    const staging = new FakeStaging();
    staging.problems = ["3 stop_times reference unknown stops"];
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows()),
      fakeRepository(staging),
    );

    await expect(service.importSchedule()).rejects.toThrow(
      "3 stop_times reference unknown stops",
    );
    expect(staging.published).toBeNull();
    expect(staging.discarded).toBe(true);
  });

  it("discards staging when loading fails", async () => {
    const staging = new FakeStaging();
    const rows = feedRows();
    const client: ScheduleFeedClient = {
      async open() {
        const feed = await fakeClient(rows).open();
        return {
          etag: feed.etag,
          read(table) {
            if (table === "stop_times") throw new Error("connection reset");
            return feed.read(table);
          },
        };
      },
    };
    const service = new ScheduleImportServiceImpl(
      client,
      fakeRepository(staging),
    );

    await expect(service.importSchedule()).rejects.toThrow("connection reset");
    expect(staging.published).toBeNull();
    expect(staging.discarded).toBe(true);
  });

  it("rejects a feed without feed_info", async () => {
    const rows = { ...feedRows(), feed_info: [] };
    const service = new ScheduleImportServiceImpl(
      fakeClient(rows),
      fakeRepository(new FakeStaging()),
    );

    await expect(service.importSchedule()).rejects.toThrow("feed_info");
  });
});
