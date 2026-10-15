import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import {
  publishSchedule,
  type ScheduleTableName,
  type ScheduleTables,
  type Stop,
} from "@tfi-gtfs/tfi-gtfs-core";
import { FsScheduleStore } from "@tfi-gtfs/tfi-gtfs-schedule-store";
import {
  SCHEDULE_SCHEMA_VERSION,
  SqliteScheduleImportRepository,
} from "@tfi-gtfs/tfi-gtfs-sqlite";

export type Rows = { [T in ScheduleTableName]: ScheduleTables[T][] };

const stop = (stopId: string, stopName: string, lat: number, lon: number) =>
  ({
    stopId,
    stopCode: null,
    stopName,
    stopDesc: null,
    stopLat: lat,
    stopLon: lon,
    zoneId: null,
    stopUrl: null,
    locationType: 0,
    parentStation: null,
    wheelchairBoarding: null,
  }) satisfies Stop;

// Dalkey is a Watched Stop; Bray Daly never was
export const DALKEY = stop("8250IR0014", "Dalkey", 53.2758, -6.1033);
export const BRAY = stop("8350IR0123", "Bray Daly", 53.2043, -6.1007);

const hours = (h: number) => h * 3600;

const stopTime = (
  tripId: string,
  stopId: string,
  stopSequence: number,
  time: number,
) => ({
  tripId,
  arrivalTime: time,
  departureTime: time,
  stopId,
  stopSequence,
  stopHeadsign: null,
  pickupType: 0,
  dropOffType: 0,
  timepoint: 1,
});

/** One DART each way between Bray and Dalkey, every day of December 2026 */
export function fixtureRows(feedVersion: string): Rows {
  return {
    agency: [
      {
        agencyId: "IR",
        agencyName: "Iarnród Éireann / Irish Rail",
        agencyUrl: "https://www.irishrail.ie/",
        agencyTimezone: "Europe/Dublin",
      },
    ],
    routes: [
      {
        routeId: "dart",
        agencyId: "IR",
        routeShortName: "DART",
        routeLongName: "Howth - Greystones",
        routeDesc: null,
        routeType: 2,
        routeUrl: null,
        routeColor: "00A650",
        routeTextColor: "FFFFFF",
      },
    ],
    trips: [
      {
        tripId: "north",
        routeId: "dart",
        serviceId: "daily",
        tripHeadsign: "Howth",
        tripShortName: null,
        directionId: 0,
        blockId: null,
        shapeId: null,
      },
      {
        tripId: "south",
        routeId: "dart",
        serviceId: "daily",
        tripHeadsign: "Greystones",
        tripShortName: null,
        directionId: 1,
        blockId: null,
        shapeId: null,
      },
    ],
    stops: [DALKEY, BRAY],
    calendar: [
      {
        serviceId: "daily",
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
        sunday: true,
        startDate: "2026-12-01",
        endDate: "2026-12-31",
      },
    ],
    calendar_dates: [],
    stop_times: [
      stopTime("north", BRAY.stopId, 1, hours(10.5)),
      stopTime("north", DALKEY.stopId, 2, hours(10.75)),
      stopTime("south", DALKEY.stopId, 1, hours(11)),
      stopTime("south", BRAY.stopId, 2, hours(11.25)),
    ],
    feed_info: [
      {
        feedVersion,
        feedPublisherName: "National Transport Authority",
        feedPublisherUrl: "https://www.nationaltransport.ie/",
        feedLang: "en",
        feedStartDate: null,
        feedEndDate: null,
        feedContactEmail: null,
      },
    ],
  };
}

async function* from<T>(rows: Iterable<T>) {
  yield* rows;
}

/** A Schedule store in a temp folder, and somewhere to build files */
export async function tempScheduleStore() {
  const root = await mkdtemp(join(tmpdir(), "tfi-gtfs-server-"));
  const store = new FsScheduleStore(join(root, "bucket"));
  let builds = 0;

  /** Builds a Schedule file from fixture rows and publishes it, as the job does */
  async function publish(feedVersion: string, rows = fixtureRows(feedVersion)) {
    const path = join(root, `build-${++builds}.sqlite`);
    const staging = await new SqliteScheduleImportRepository(
      path,
    ).createStaging();
    for (const table of Object.keys(rows) as ScheduleTableName[]) {
      await staging.load(table, from(rows[table] as never[]));
    }
    const problems = await staging.check();
    if (problems.length > 0) throw new Error(problems.join("\n"));
    const built = await staging.build({ feedVersion, etag: null });
    const pointer = await publishSchedule(store, {
      schemaVersion: SCHEDULE_SCHEMA_VERSION,
      feedVersion,
      etag: null,
      body: Readable.from(built.read()).pipe(createGzip()),
    });
    await rm(path, { force: true });
    return pointer;
  }

  return {
    root,
    store,
    publish,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
