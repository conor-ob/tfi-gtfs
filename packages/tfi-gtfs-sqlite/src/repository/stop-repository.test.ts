import type { Stop, StopRepository } from "@tfi-gtfs/tfi-gtfs-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSchedule, type Rows } from "../test/build-schedule";
import { SqliteStopRepository } from "./stop-repository";

const stop = (
  stopId: string,
  stopLat: number,
  stopLon: number,
  locationType: number | null = 0,
): Stop => ({
  stopId,
  stopCode: stopId,
  stopName: stopId,
  stopDesc: null,
  stopLat,
  stopLon,
  zoneId: null,
  stopUrl: null,
  locationType,
  parentStation: null,
  wheelchairBoarding: null,
});

// Around O'Connell Bridge
const here = { lat: 53.3473, lon: -6.2591 };
const north = stop("north", 53.348, -6.2591); // 78 m
const west = stop("west", 53.3473, -6.262, null); // 193 m
// Inside the bounding box but outside the circle
const corner = stop("corner", 53.3508, -6.2541); // 512 m
const far = stop("far", 53.353, -6.2591); // 634 m
const station = stop("station", 53.3474, -6.2591, 1); // 11 m

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
      routeLongName: null,
      routeDesc: null,
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
      serviceId: "daily",
      tripHeadsign: null,
      tripShortName: null,
      directionId: 0,
      blockId: null,
      shapeId: null,
    },
  ],
  stops: [north, west, corner, far, station],
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
    {
      tripId: "t1",
      arrivalTime: 0,
      departureTime: 0,
      stopId: "north",
      stopSequence: 1,
      stopHeadsign: null,
      pickupType: 0,
      dropOffType: 0,
      timepoint: 1,
    },
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
let repository: StopRepository;

describe("SqliteStopRepository", () => {
  beforeAll(async () => {
    built = await buildSchedule(schedule);
    repository = new SqliteStopRepository(built.schedule);
  });

  afterAll(async () => {
    await built.close();
  });

  it("finds Stops within the radius, nearest first", async () => {
    const stops = await repository.findStopsNear({
      ...here,
      radius: 500,
      limit: 10,
    });

    expect(stops).toEqual([
      { ...north, distance: expect.closeTo(78, 0) },
      { ...west, distance: expect.closeTo(193, 0) },
    ]);
  });

  it("trims the corners of the bounding box", async () => {
    const stops = await repository.findStopsNear({
      ...here,
      radius: 520,
      limit: 10,
    });

    expect(stops.map((row) => row.stopId)).toEqual(["north", "west", "corner"]);
  });

  it("leaves out Stations", async () => {
    const stops = await repository.findStopsNear({
      ...here,
      radius: 50,
      limit: 10,
    });

    expect(stops).toEqual([]);
  });

  it("keeps to the limit", async () => {
    const stops = await repository.findStopsNear({
      ...here,
      radius: 2000,
      limit: 3,
    });

    expect(stops.map((row) => row.stopId)).toEqual(["north", "west", "corner"]);
  });
});
