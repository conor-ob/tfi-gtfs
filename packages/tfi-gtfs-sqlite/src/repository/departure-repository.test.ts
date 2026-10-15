import type {
  DepartureRepository,
  StopTime,
  Trip,
} from "@tfi-gtfs/tfi-gtfs-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSchedule, type Rows } from "../test/build-schedule";
import { SqliteDepartureRepository } from "./departure-repository";

const trip = (tripId: string, serviceId: string): Trip => ({
  tripId,
  routeId: "r46a",
  serviceId,
  tripHeadsign: "Dún Laoghaire",
  tripShortName: null,
  directionId: 0,
  blockId: null,
  shapeId: null,
});

const stopTime = (
  tripId: string,
  stopId: string,
  stopSequence: number,
  time: number,
  overrides: Partial<StopTime> = {},
): StopTime => ({
  tripId,
  arrivalTime: time,
  departureTime: time,
  stopId,
  stopSequence,
  stopHeadsign: null,
  pickupType: 0,
  dropOffType: 0,
  timepoint: 1,
  ...overrides,
});

const stop = (stopId: string) => ({
  stopId,
  stopCode: stopId,
  stopName: stopId,
  stopDesc: null,
  stopLat: 53.353,
  stopLon: -6.263,
  zoneId: null,
  stopUrl: null,
  locationType: 0,
  parentStation: null,
  wheelchairBoarding: null,
});

const hours = (h: number) => h * 3600;

// Weekdays in December, except Tuesday 8 December, when the `extra` service
// runs instead
const schedule: Rows = {
  agency: [
    {
      agencyId: "1",
      agencyName: "Dublin Bus",
      agencyUrl: "https://www.dublinbus.ie/",
      agencyTimezone: "Europe/Dublin",
    },
  ],
  routes: [
    {
      routeId: "r46a",
      agencyId: "1",
      routeShortName: "46A",
      routeLongName: "Phoenix Park - Dún Laoghaire",
      routeDesc: null,
      routeType: 3,
      routeUrl: null,
      routeColor: "FFD400",
      routeTextColor: null,
    },
  ],
  trips: [
    trip("t1", "weekday"),
    trip("t2", "weekday"),
    trip("t3", "extra"),
    trip("t4", "weekday"),
  ],
  stops: [stop("s1"), stop("s2")],
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
      startDate: "2026-12-01",
      endDate: "2026-12-31",
    },
  ],
  calendar_dates: [
    { serviceId: "weekday", date: "2026-12-08", exceptionType: 2 },
    { serviceId: "extra", date: "2026-12-08", exceptionType: 1 },
  ],
  stop_times: [
    stopTime("t1", "s1", 1, hours(8)),
    stopTime("t1", "s2", 2, hours(8.5)),
    stopTime("t2", "s1", 1, hours(25), { stopHeadsign: "City Centre" }),
    stopTime("t3", "s1", 1, hours(8.5)),
    // t4 ends at s1, so nobody can board there
    stopTime("t4", "s2", 1, hours(7.5)),
    stopTime("t4", "s1", 2, hours(8.25), { pickupType: 1 }),
  ],
  feed_info: [
    {
      feedVersion: "v1",
      feedPublisherName: "National Transport Authority",
      feedPublisherUrl: "https://www.nationaltransport.ie/",
      feedLang: "en",
      feedStartDate: null,
      feedEndDate: null,
      feedContactEmail: null,
    },
  ],
};

let built: Awaited<ReturnType<typeof buildSchedule>>;
let repository: DepartureRepository;

const allDay = { stopId: "s1", fromTime: 0, toTime: hours(48), limit: 10 };

describe("SqliteDepartureRepository", () => {
  beforeAll(async () => {
    built = await buildSchedule(schedule);
    repository = new SqliteDepartureRepository(built.schedule);
  });

  afterAll(async () => {
    await built.close();
  });

  it("finds Stop Times of Trips running on a regular weekday", async () => {
    const stopTimes = await repository.findScheduledStopTimes({
      ...allDay,
      serviceDate: "2026-12-07",
    });

    expect(stopTimes).toEqual([
      {
        tripId: "t1",
        stopId: "s1",
        stopSequence: 1,
        departureTime: hours(8),
        headsign: "Dún Laoghaire",
        directionId: 0,
        routeId: "r46a",
        routeShortName: "46A",
        routeLongName: "Phoenix Park - Dún Laoghaire",
        routeColor: "FFD400",
        routeTextColor: null,
        routeType: 3,
        agencyId: "1",
      },
      expect.objectContaining({
        tripId: "t2",
        departureTime: hours(25),
        headsign: "City Centre",
      }),
    ]);
  });

  it("applies added and removed dates", async () => {
    const stopTimes = await repository.findScheduledStopTimes({
      ...allDay,
      serviceDate: "2026-12-08",
    });

    expect(stopTimes.map((row) => row.tripId)).toEqual(["t3"]);
  });

  it("finds nothing on days outside the Service Calendar", async () => {
    for (const serviceDate of ["2026-12-12", "2027-01-04"]) {
      expect(
        await repository.findScheduledStopTimes({ ...allDay, serviceDate }),
      ).toEqual([]);
    }
  });

  it("keeps to the window and the limit", async () => {
    const window = await repository.findScheduledStopTimes({
      ...allDay,
      serviceDate: "2026-12-07",
      fromTime: hours(8) + 1,
      toTime: hours(25),
    });
    const limited = await repository.findScheduledStopTimes({
      ...allDay,
      serviceDate: "2026-12-07",
      limit: 1,
    });

    expect(window.map((row) => row.tripId)).toEqual(["t2"]);
    expect(limited.map((row) => row.tripId)).toEqual(["t1"]);
  });

  it("keeps to the direction when given one", async () => {
    const query = { ...allDay, serviceDate: "2026-12-07" };

    const outbound = await repository.findScheduledStopTimes({
      ...query,
      directionId: 0,
    });
    const inbound = await repository.findScheduledStopTimes({
      ...query,
      directionId: 1,
    });

    expect(outbound.map((row) => row.tripId)).toEqual(["t1", "t2"]);
    expect(inbound).toEqual([]);
  });

  it("finds a Stop by id", async () => {
    expect(await repository.findStop("s1")).toEqual(stop("s1"));
    expect(await repository.findStop("missing")).toBeNull();
  });
});
