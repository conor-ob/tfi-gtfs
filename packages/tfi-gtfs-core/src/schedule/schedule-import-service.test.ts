import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type SchedulePointer,
  schedulePointerKey,
} from "./domain/schedule-store";
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
import type { ScheduleStore } from "./interfaces/outbound/schedule-store";
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

const FILE = "SQLite format 3\0 fake Schedule";

class FakeStaging implements ScheduleStaging {
  loaded: Partial<Rows> = {};
  problems: string[] = [];
  built: ScheduleImport | null = null;
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

  async build(scheduleImport: ScheduleImport) {
    this.built = scheduleImport;
    return {
      sizeBytes: FILE.length,
      async *read() {
        yield new TextEncoder().encode(FILE);
      },
    };
  }

  async discard() {
    this.discarded = true;
  }
}

function fakeRepository(staging: FakeStaging): ScheduleImportRepository {
  return { schemaVersion: 1, createStaging: async () => staging };
}

/** A bucket in memory. `failPuts` makes every write of a matching key throw */
class MemoryScheduleStore implements ScheduleStore {
  objects = new Map<string, Uint8Array>();
  failPuts: RegExp | null = null;

  async getPointer(schemaVersion: number) {
    const object = this.objects.get(schedulePointerKey(schemaVersion));
    if (!object) return null;
    return JSON.parse(new TextDecoder().decode(object)) as SchedulePointer;
  }

  async getObject(key: string) {
    const object = this.objects.get(key);
    if (!object) throw new Error(`No such key: ${key}`);
    return (async function* () {
      yield object;
    })();
  }

  async put(key: string, body: AsyncIterable<Uint8Array> | string) {
    const chunks: Uint8Array[] =
      typeof body === "string" ? [new TextEncoder().encode(body)] : [];
    if (typeof body !== "string") {
      for await (const chunk of body) chunks.push(chunk);
    }
    if (this.failPuts?.test(key)) throw new Error(`upload failed: ${key}`);
    this.objects.set(key, Buffer.concat(chunks));
    return { etag: key };
  }

  async list(prefix: string) {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, lastModified: new Date(0) }));
  }

  async delete(keys: readonly string[]) {
    for (const key of keys) this.objects.delete(key);
  }

  /** Publishes a pointer as an earlier import would have */
  withLatest(pointer: Pick<SchedulePointer, "feedVersion" | "etag">) {
    const key = `schedule/v1/${pointer.feedVersion}.sqlite.gz`;
    this.objects.set(key, new Uint8Array());
    this.objects.set(
      schedulePointerKey(1),
      new TextEncoder().encode(
        JSON.stringify({
          key,
          sha256: "0".repeat(64),
          importedAt: "2026-10-14T03:00:00.000Z",
          ...pointer,
        }),
      ),
    );
    return this;
  }
}

describe("ScheduleImportServiceImpl", () => {
  it("loads every Stop and what its Trips reference", async () => {
    const staging = new FakeStaging();
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows()),
      fakeRepository(staging),
      new MemoryScheduleStore(),
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
    expect(staging.built).toEqual({ feedVersion: "v2", etag: "etag-2" });
    expect(result).toEqual({
      status: "imported",
      feedVersion: "v2",
      key: "schedule/v1/v2.sqlite.gz",
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
      sizeBytes: FILE.length,
      gzipBytes: expect.any(Number),
    });
  });

  it("publishes the gzipped file and points latest.json at it", async () => {
    const store = new MemoryScheduleStore();
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows()),
      fakeRepository(new FakeStaging()),
      store,
    );

    const result = await service.importSchedule();

    const object = store.objects.get("schedule/v1/v2.sqlite.gz");
    expect(object && gunzipSync(object).toString()).toBe(FILE);
    expect(result).toMatchObject({ gzipBytes: object?.byteLength });
    expect(await store.getPointer(1)).toMatchObject({
      key: "schedule/v1/v2.sqlite.gz",
      feedVersion: "v2",
      etag: "etag-2",
    });
  });

  it("skips the import when the feed is unchanged", async () => {
    const staging = new FakeStaging();
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows()),
      fakeRepository(staging),
      new MemoryScheduleStore().withLatest({
        feedVersion: "v2",
        etag: "etag-2",
      }),
    );

    const result = await service.importSchedule();

    expect(result).toEqual({
      status: "skipped",
      feedVersion: "v2",
      key: "schedule/v1/v2.sqlite.gz",
    });
    expect(staging.loaded).toEqual({});
  });

  it.each([
    { feedVersion: "v2", etag: "etag-1" },
    { feedVersion: "v1", etag: "etag-2" },
  ])(
    "imports when the pointer has Feed Version $feedVersion and ETag $etag",
    async (latest) => {
      const store = new MemoryScheduleStore().withLatest(latest);
      const service = new ScheduleImportServiceImpl(
        fakeClient(feedRows()),
        fakeRepository(new FakeStaging()),
        store,
      );

      const result = await service.importSchedule();

      expect(result.status).toBe("imported");
      expect((await store.getPointer(1))?.key).toBe("schedule/v1/v2.sqlite.gz");
    },
  );

  it("leaves latest.json and staging untouched when checks find problems", async () => {
    const staging = new FakeStaging();
    staging.problems = ["3 stop_times reference unknown stops"];
    const store = new MemoryScheduleStore().withLatest({
      feedVersion: "v1",
      etag: "etag-1",
    });
    const before = await store.getPointer(1);
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows()),
      fakeRepository(staging),
      store,
    );

    await expect(service.importSchedule()).rejects.toThrow(
      "3 stop_times reference unknown stops",
    );
    expect(staging.built).toBeNull();
    expect(staging.discarded).toBe(true);
    expect(await store.getPointer(1)).toEqual(before);
    expect([...store.objects.keys()]).not.toContain("schedule/v1/v2.sqlite.gz");
  });

  it("leaves latest.json untouched when the upload fails", async () => {
    const staging = new FakeStaging();
    const store = new MemoryScheduleStore().withLatest({
      feedVersion: "v1",
      etag: "etag-1",
    });
    store.failPuts = /\.sqlite\.gz$/;
    const before = await store.getPointer(1);
    const service = new ScheduleImportServiceImpl(
      fakeClient(feedRows()),
      fakeRepository(staging),
      store,
    );

    await expect(service.importSchedule()).rejects.toThrow("upload failed");
    expect(staging.discarded).toBe(true);
    expect(await store.getPointer(1)).toEqual(before);
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
    const store = new MemoryScheduleStore();
    const service = new ScheduleImportServiceImpl(
      client,
      fakeRepository(staging),
      store,
    );

    await expect(service.importSchedule()).rejects.toThrow("connection reset");
    expect(staging.built).toBeNull();
    expect(staging.discarded).toBe(true);
    expect(await store.getPointer(1)).toBeNull();
  });

  it("rejects a feed without feed_info", async () => {
    const rows = { ...feedRows(), feed_info: [] };
    const service = new ScheduleImportServiceImpl(
      fakeClient(rows),
      fakeRepository(new FakeStaging()),
      new MemoryScheduleStore(),
    );

    await expect(service.importSchedule()).rejects.toThrow("feed_info");
  });
});
