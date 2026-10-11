import type {
  ScheduleImportRepository,
  ScheduleStaging,
  ScheduleTableName,
  ScheduleTables,
} from "@tfi-gtfs/tfi-gtfs-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { injectDependencies } from "../module/dependencies";

type Rows = { [T in ScheduleTableName]: ScheduleTables[T][] };

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

async function* from<T>(rows: T[]) {
  yield* rows;
}

async function loadAll(staging: ScheduleStaging, rows: Rows) {
  for (const table of Object.keys(rows) as ScheduleTableName[]) {
    await staging.load(table, from(rows[table] as never[]));
  }
}

const dependencies = injectDependencies();
const repository: ScheduleImportRepository =
  dependencies.scheduleImportRepository;
const database = createDatabaseConnection();

describe("ScheduleImportRepositoryImpl", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await database.execute("TRUNCATE schedule_import");
  });

  afterAll(async () => {
    await dependencies.close();
    await database.$client.end();
  });

  it("publishes a checked Schedule and records the import", async () => {
    const rows = schedule();
    const staging = await repository.createStaging();
    await loadAll(staging, rows);

    expect(await staging.check()).toEqual([]);
    await staging.publish({ feedVersion: "v1", etag: '"abc"' });

    const { rows: agencies } = await database.execute(
      "SELECT agency_name FROM gtfs.agency",
    );
    expect(agencies).toEqual([{ agency_name: 'Dublin Bus "BÁC"' }]);
    const { rows: stopTimes } = await database.execute(
      "SELECT departure_time, stop_headsign FROM gtfs.stop_times",
    );
    expect(stopTimes).toEqual([
      { departure_time: 89_520, stop_headsign: null },
    ]);
    // An empty string survives COPY as an empty string, not NULL
    const { rows: routes } = await database.execute(
      "SELECT route_desc, route_url FROM gtfs.routes",
    );
    expect(routes).toEqual([{ route_desc: "", route_url: null }]);
    const { rows: indexes } = await database.execute(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'gtfs' AND tablename = 'stop_times' ORDER BY 1",
    );
    expect(indexes).toEqual([
      { indexname: "stop_times_stop_id_departure_time_idx" },
      { indexname: "stop_times_trip_id_stop_sequence_pk" },
    ]);
    expect(await repository.findLatestImport()).toEqual({
      feedVersion: "v1",
      etag: '"abc"',
    });
  });

  it("reports rows that reference missing rows", async () => {
    const rows = schedule();
    rows.stop_times = rows.stop_times.map((row) => ({
      ...row,
      stopId: "missing",
    }));
    rows.trips = rows.trips.map((row) => ({ ...row, serviceId: "missing" }));
    const staging = await repository.createStaging();
    try {
      await loadAll(staging, rows);

      expect(await staging.check()).toEqual([
        "1 trips reference unknown Service Calendars",
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

    await expect(staging.check()).rejects.toThrow(/could not create unique/);
    await staging.discard();

    const { rows: schemas } = await database.execute(
      "SELECT 1 FROM pg_namespace WHERE nspname = 'gtfs_staging'",
    );
    expect(schemas).toEqual([]);
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
});
