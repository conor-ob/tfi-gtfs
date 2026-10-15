import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  fetchSchedule,
  injectScheduleImportDependencies,
  type ScheduleFeedClient,
  ScheduleImportError,
  type ScheduleTableName,
} from "@tfi-gtfs/tfi-gtfs-core";
import { FsScheduleStore } from "@tfi-gtfs/tfi-gtfs-schedule-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSchedule, ScheduleDatabase } from "../schedule-database";
import { SCHEDULE_SCHEMA_VERSION } from "../schema";
import { from, loadAll, type Rows, tempDir } from "../test/build-schedule";
import { SqliteDepartureRepository } from "./departure-repository";
import { SqliteScheduleImportRepository } from "./schedule-import-repository";
import { SqliteStopRepository } from "./stop-repository";

function schedule(): Rows {
  return {
    agency: [
      {
        agencyId: "1",
        agencyName: 'Dublin Bus "BÁC"',
        agencyUrl: "https://www.dublinbus.ie/",
        agencyTimezone: "Europe/Dublin",
      },
    ],
    routes: [
      {
        routeId: "r46a",
        agencyId: "1",
        routeShortName: "46A",
        routeLongName: "Phoenix Park - Dún Laoghaire, Mountjoy Sq",
        routeDesc: "",
        routeType: 3,
        routeUrl: null,
        routeColor: null,
        routeTextColor: null,
      },
    ],
    trips: [
      {
        tripId: "t1",
        routeId: "r46a",
        serviceId: "weekday",
        tripHeadsign: "Dún Laoghaire",
        tripShortName: null,
        directionId: 0,
        blockId: null,
        shapeId: "shape1",
      },
    ],
    stops: [
      {
        stopId: "s1",
        stopCode: "1",
        stopName: "Parnell Square",
        stopDesc: null,
        stopLat: 53.353,
        stopLon: -6.263,
        zoneId: null,
        stopUrl: null,
        locationType: 0,
        parentStation: null,
        wheelchairBoarding: 1,
      },
    ],
    calendar: [
      {
        serviceId: "weekday",
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: false,
        sunday: false,
        startDate: "2026-10-10",
        endDate: "2027-10-10",
      },
    ],
    calendar_dates: [
      { serviceId: "weekday", date: "2026-10-26", exceptionType: 2 },
    ],
    stop_times: [
      {
        tripId: "t1",
        arrivalTime: 89_520,
        departureTime: 89_520,
        stopId: "s1",
        stopSequence: 1,
        stopHeadsign: null,
        pickupType: 0,
        dropOffType: 1,
        timepoint: 1,
      },
    ],
    feed_info: [
      {
        feedVersion: "v1",
        feedPublisherName: "National Transport Authority",
        feedPublisherUrl: "https://www.nationaltransport.ie/",
        feedLang: "en",
        feedStartDate: "2026-10-10",
        feedEndDate: null,
        feedContactEmail: null,
      },
    ],
  };
}

/** The fixture's one row of a table */
const only = <T>(rows: T[]): T => {
  const [row] = rows;
  if (!row) throw new Error("No fixture row");
  return row;
};

const query = (path: string, sql: string) => {
  const database = openSchedule(path);
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
};

let dir: string;
let cleanup: () => Promise<void>;
let path: string;
let repository: SqliteScheduleImportRepository;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  path = join(dir, "schedule.sqlite");
  repository = new SqliteScheduleImportRepository(path);
});

afterEach(async () => {
  await cleanup();
});

describe("SqliteScheduleImportRepository", () => {
  it("builds a checked Schedule in the integer layout and records the import", async () => {
    const staging = await repository.createStaging();
    await loadAll(staging, schedule());

    expect(await staging.check()).toEqual([]);
    const file = await staging.build({ feedVersion: "v1", etag: '"abc"' });

    expect(existsSync(`${path}.staging`)).toBe(false);
    expect(file.sizeBytes).toBe(statSync(path).size);
    const chunks: Uint8Array[] = [];
    for await (const chunk of file.read()) chunks.push(chunk);
    expect(Buffer.concat(chunks).subarray(0, 16).toString()).toBe(
      "SQLite format 3\0",
    );
    expect(query(path, "SELECT agency_name FROM agency")).toEqual([
      { agency_name: 'Dublin Bus "BÁC"' },
    ]);
    expect(query(path, "SELECT * FROM stop_times")).toEqual([
      {
        stop: 1,
        departure_time: 89_520,
        trip: 1,
        stop_sequence: 1,
        stop_headsign: null,
        pickup_type: 0,
      },
    ]);
    // An empty string stays an empty string, not NULL
    expect(query(path, "SELECT route_desc, route_url FROM routes")).toEqual([
      { route_desc: "", route_url: null },
    ]);
    expect(query(path, "PRAGMA user_version")).toEqual([
      { user_version: SCHEDULE_SCHEMA_VERSION },
    ]);
    // The text tables are gone
    expect(
      query(path, "SELECT name FROM sqlite_schema WHERE name LIKE 'staging%'"),
    ).toEqual([]);
    expect(
      query(path, "SELECT feed_version, etag FROM schedule_import"),
    ).toEqual([{ feed_version: "v1", etag: '"abc"' }]);
  });

  it("reports rows that reference missing rows", async () => {
    const rows = schedule();
    rows.stop_times = [
      { ...only(rows.stop_times), stopId: "missing" },
      { ...only(rows.stop_times), tripId: "missing" },
    ];
    rows.trips = rows.trips.map((row) => ({ ...row, serviceId: "missing" }));
    const staging = await repository.createStaging();
    try {
      await loadAll(staging, rows);

      expect(await staging.check()).toEqual([
        "1 trips reference unknown Service Calendars",
        "1 stop_times reference unknown trips",
        "1 stop_times reference unknown stops",
      ]);
    } finally {
      await staging.discard();
    }
  });

  it("fails the check on duplicate keys and discards staging", async () => {
    const rows = schedule();
    rows.stops = [...rows.stops, ...rows.stops];
    const staging = await repository.createStaging();
    await loadAll(staging, rows);

    await expect(staging.check()).rejects.toThrow(/UNIQUE constraint failed/);
    await staging.discard();

    expect(existsSync(`${path}.staging`)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("allows only one import at a time", async () => {
    const staging = await repository.createStaging();
    try {
      await expect(repository.createStaging()).rejects.toThrow(
        "already running",
      );
    } finally {
      await staging.discard();
    }
  });

  it("starts afresh over a staging file a crashed import left behind", async () => {
    const crashed = await repository.createStaging();
    await crashed.load("stops", from(schedule().stops));
    // Closing the handle without discarding, as a crash would
    (crashed as unknown as { database: { close(): void } }).database.close();

    const staging = await repository.createStaging();
    await loadAll(staging, schedule());

    expect(await staging.check()).toEqual([]);
    await staging.discard();
  });
});

/** A feed of fixture rows, as ScheduleImportService reads it */
const feedOf = (rows: Rows): ScheduleFeedClient => ({
  async open() {
    return {
      etag: '"fixture"',
      read: <T extends ScheduleTableName>(table: T) => from(rows[table]),
    };
  },
});

/** Downloads the published Schedule as the server would, and opens it */
async function openPublished(store: FsScheduleStore) {
  const fetched = await fetchSchedule(store, SCHEDULE_SCHEMA_VERSION);
  if (!fetched) throw new Error("Nothing published");
  const chunks: Uint8Array[] = [];
  for await (const chunk of fetched.body) chunks.push(chunk);
  const downloaded = join(dir, "downloaded.sqlite");
  await writeFile(downloaded, gunzipSync(Buffer.concat(chunks)));
  return openSchedule(downloaded);
}

describe("Schedule Import into SQLite", () => {
  let store: FsScheduleStore;

  beforeEach(() => {
    store = new FsScheduleStore(join(dir, "bucket"));
  });

  it("keeps every Stop, with Departures and in Nearby Stops", async () => {
    const rows = schedule();
    // Not a Watched Stop
    rows.stops.push({
      ...only(rows.stops),
      stopId: "8220DB004516",
      stopName: "Stillorgan Road",
      stopLat: 53.3,
      stopLon: -6.2,
    });
    rows.stop_times.push({
      ...only(rows.stop_times),
      stopId: "8220DB004516",
      stopSequence: 2,
      departureTime: 90_000,
    });
    const { scheduleImportService } = injectScheduleImportDependencies(
      feedOf(rows),
      repository,
      store,
    );

    expect(await scheduleImportService.importSchedule()).toMatchObject({
      status: "imported",
      key: "schedule/v1/v1.sqlite.gz",
      rowCounts: { stops: 2, stop_times: 2 },
    });

    const database = new ScheduleDatabase(await openPublished(store));
    try {
      const departures = new SqliteDepartureRepository(database);
      const stops = new SqliteStopRepository(database);
      expect(
        await departures.findScheduledStopTimes({
          stopId: "8220DB004516",
          serviceDate: "2026-12-07",
          fromTime: 0,
          toTime: 48 * 3600,
          limit: 10,
        }),
      ).toEqual([
        expect.objectContaining({ tripId: "t1", departureTime: 90_000 }),
      ]);
      expect(
        await stops.findStopsNear({
          lat: 53.3,
          lon: -6.2,
          radius: 100,
          limit: 10,
        }),
      ).toEqual([expect.objectContaining({ stopId: "8220DB004516" })]);
    } finally {
      database.close();
    }

    // The same feed again is skipped
    expect(await scheduleImportService.importSchedule()).toEqual({
      status: "skipped",
      feedVersion: "v1",
      key: "schedule/v1/v1.sqlite.gz",
    });
  });

  it("fails the import on orphaned Stop Times and leaves latest.json alone", async () => {
    const { scheduleImportService: first } = injectScheduleImportDependencies(
      feedOf(schedule()),
      repository,
      store,
    );
    await first.importSchedule();

    const rows = schedule();
    rows.feed_info = [{ ...only(rows.feed_info), feedVersion: "v2" }];
    rows.stop_times.push({
      ...only(rows.stop_times),
      stopId: "missing",
      stopSequence: 2,
    });
    const { scheduleImportService: second } = injectScheduleImportDependencies(
      feedOf(rows),
      repository,
      store,
    );
    const published = await store.getPointer(SCHEDULE_SCHEMA_VERSION);

    await expect(second.importSchedule()).rejects.toThrow(ScheduleImportError);
    expect(existsSync(`${path}.staging`)).toBe(false);
    expect(await store.getPointer(SCHEDULE_SCHEMA_VERSION)).toEqual(published);
    expect(
      (await store.list("schedule/")).map(({ key }) => key).sort(),
    ).toEqual(["schedule/v1/latest.json", "schedule/v1/v1.sqlite.gz"]);
  });
});
