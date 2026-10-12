import { describe, expect, it } from "vitest";
import {
  type TripUpdate,
  type TripUpdateSnapshot,
  tripUpdateKey,
} from "../realtime/domain/types";
import type { RealtimeService } from "../realtime/interfaces/inbound/realtime-service";
import type { Stop } from "../schedule/domain/types";
import { DepartureServiceImpl, StopNotFoundError } from "./departure-service";
import type { Departure, ScheduledStopTime } from "./domain/types";
import type { DepartureRepository } from "./interfaces/outbound/departure-repository";

const stop: Stop = {
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
  wheelchairBoarding: null,
};

const stopTime = (
  tripId: string,
  departureTime: number,
): ScheduledStopTime => ({
  tripId,
  stopId: "s1",
  stopSequence: 1,
  departureTime,
  headsign: "Dún Laoghaire",
  directionId: 0,
  routeId: "r46a",
  routeShortName: "46A",
  routeLongName: null,
  routeType: 3,
  agencyId: "1",
});

const departure = (
  tripId: string,
  serviceDate: string,
  scheduledDeparture: string,
): Departure => {
  const { departureTime: _, ...rest } = stopTime(tripId, 0);
  return {
    ...rest,
    serviceDate,
    scheduledDeparture: new Date(scheduledDeparture),
    predictedDeparture: null,
  };
};

/** Serves the given Trip Updates, or none */
function fakeRealtime(tripUpdates?: TripUpdate[]): RealtimeService {
  const snapshot: TripUpdateSnapshot | null = tripUpdates
    ? {
        timestamp: new Date(),
        tripUpdates: new Map(
          tripUpdates.map((u) => [tripUpdateKey(u.tripId, u.startDate), u]),
        ),
      }
    : null;
  return { getTripUpdates: async () => snapshot, stop: () => {} };
}

const delayed = (
  tripId: string,
  startDate: string,
  delay: number,
): TripUpdate => ({
  tripId,
  startDate,
  canceled: false,
  delay,
  stopTimeUpdates: [],
});

type Query = Parameters<DepartureRepository["findScheduledStopTimes"]>[0];

/** Answers like the real query, from Stop Times keyed by Service Day */
function fakeRepository(byServiceDate: Record<string, ScheduledStopTime[]>) {
  const queries: Query[] = [];
  const repository: DepartureRepository = {
    findStop: async (stopId) => (stopId === stop.stopId ? stop : null),
    findScheduledStopTimes: async (query) => {
      queries.push(query);
      return (byServiceDate[query.serviceDate] ?? [])
        .filter(
          (row) =>
            row.departureTime >= query.fromTime &&
            row.departureTime <= query.toTime &&
            (query.directionId === undefined ||
              row.directionId === query.directionId),
        )
        .sort((a, b) => a.departureTime - b.departureTime)
        .slice(0, query.limit);
    },
  };
  return { repository, queries };
}

const hours = (h: number) => h * 3600;

describe("DepartureServiceImpl", () => {
  it("places Stop Times on their Service Day, including yesterday's after midnight", async () => {
    const { repository } = fakeRepository({
      // 00:45 on 2 December, still on 1 December's Service Day
      "2026-12-01": [stopTime("late", hours(24.75))],
      "2026-12-02": [
        stopTime("early", hours(6)),
        stopTime("gone", hours(0.25)),
      ],
    });
    const service = new DepartureServiceImpl(repository, fakeRealtime());

    const departures = await service.getDepartures({
      stopId: "s1",
      from: new Date("2026-12-02T00:30:00Z"),
      limit: 10,
    });

    expect(departures).toStrictEqual([
      departure("late", "2026-12-01", "2026-12-02T00:45:00Z"),
      departure("early", "2026-12-02", "2026-12-02T06:00:00Z"),
    ]);
  });

  it("uses local time in summer", async () => {
    const { repository } = fakeRepository({
      "2026-07-01": [stopTime("t1", hours(8))],
    });
    const service = new DepartureServiceImpl(repository, fakeRealtime());

    const [departure] = await service.getDepartures({
      stopId: "s1",
      from: new Date("2026-07-01T06:00:00Z"),
      limit: 10,
    });

    expect(departure?.scheduledDeparture).toEqual(
      new Date("2026-07-01T07:00:00Z"),
    );
  });

  it("includes tomorrow's first Departures late in the evening", async () => {
    const { repository } = fakeRepository({
      "2026-12-01": [stopTime("last", hours(23.75))],
      "2026-12-02": [stopTime("first", hours(5.5))],
    });
    const service = new DepartureServiceImpl(repository, fakeRealtime());

    const departures = await service.getDepartures({
      stopId: "s1",
      from: new Date("2026-12-01T23:00:00Z"),
      limit: 10,
    });

    expect(departures.map((d) => [d.tripId, d.serviceDate])).toEqual([
      ["last", "2026-12-01"],
      ["first", "2026-12-02"],
    ]);
  });

  it("queries each Service Day for the window it covers", async () => {
    const { repository, queries } = fakeRepository({});
    const service = new DepartureServiceImpl(repository, fakeRealtime());

    await service.getDepartures({
      stopId: "s1",
      from: new Date("2026-12-02T10:00:00.500Z"),
      limit: 5,
    });

    expect(queries).toEqual([
      {
        stopId: "s1",
        serviceDate: "2026-12-01",
        fromTime: hours(34) + 1,
        toTime: hours(58),
        limit: 5,
      },
      {
        stopId: "s1",
        serviceDate: "2026-12-02",
        fromTime: hours(10) + 1,
        toTime: hours(34),
        limit: 5,
      },
      {
        stopId: "s1",
        serviceDate: "2026-12-03",
        fromTime: 0,
        toTime: hours(10),
        limit: 5,
      },
    ]);
  });

  it("returns the earliest Departures across Service Days up to the limit", async () => {
    const { repository } = fakeRepository({
      "2026-12-01": [stopTime("a", hours(24.5)), stopTime("c", hours(25.5))],
      "2026-12-02": [stopTime("b", hours(1)), stopTime("d", hours(2))],
    });
    const service = new DepartureServiceImpl(repository, fakeRealtime());

    const departures = await service.getDepartures({
      stopId: "s1",
      from: new Date("2026-12-02T00:00:00Z"),
      limit: 3,
    });

    expect(departures.map((d) => d.tripId)).toEqual(["a", "b", "c"]);
  });

  it("fills the limit with Departures in the given direction", async () => {
    const { repository } = fakeRepository({
      "2026-12-02": [
        { ...stopTime("in1", hours(1)), directionId: 1 },
        stopTime("out1", hours(2)),
        { ...stopTime("in2", hours(3)), directionId: 1 },
        stopTime("out2", hours(4)),
      ],
    });
    const service = new DepartureServiceImpl(repository, fakeRealtime());

    const departures = await service.getDepartures({
      stopId: "s1",
      from: new Date("2026-12-02T00:00:00Z"),
      directionId: 0,
      limit: 2,
    });

    expect(departures.map((d) => d.tripId)).toEqual(["out1", "out2"]);
  });

  it("defaults to now", async () => {
    const { repository } = fakeRepository({
      "2026-12-02": [stopTime("past", hours(9)), stopTime("next", hours(11))],
    });
    const service = new DepartureServiceImpl(
      repository,
      fakeRealtime(),
      () => new Date("2026-12-02T10:00:00Z"),
    );

    const departures = await service.getDepartures({ stopId: "s1", limit: 10 });

    expect(departures.map((d) => d.tripId)).toEqual(["next"]);
  });

  it("adds Predicted Departures and orders by them", async () => {
    const { repository } = fakeRepository({
      "2026-12-02": [
        stopTime("late", hours(10)),
        stopTime("on-time", hours(10.1)),
      ],
    });
    const service = new DepartureServiceImpl(
      repository,
      fakeRealtime([delayed("late", "2026-12-02", 15 * 60)]),
    );

    const departures = await service.getDepartures({
      stopId: "s1",
      from: new Date("2026-12-02T09:00:00Z"),
      limit: 10,
    });

    expect(
      departures.map((d) => [d.tripId, d.predictedDeparture?.toISOString()]),
    ).toEqual([
      ["on-time", undefined],
      ["late", "2026-12-02T10:15:00.000Z"],
    ]);
  });

  it("includes a late Trip whose Scheduled Departure has passed", async () => {
    const { repository } = fakeRepository({
      "2026-12-02": [
        stopTime("late", hours(9.5)),
        stopTime("gone", hours(9.75)),
        stopTime("next", hours(10.25)),
      ],
    });
    const service = new DepartureServiceImpl(
      repository,
      fakeRealtime([delayed("late", "2026-12-02", 40 * 60)]),
    );

    const departures = await service.getDepartures({
      stopId: "s1",
      from: new Date("2026-12-02T10:00:00Z"),
      limit: 10,
    });

    expect(departures.map((d) => d.tripId)).toEqual(["late", "next"]);
  });

  it("leaves out cancelled Trips but still fills the limit", async () => {
    const { repository } = fakeRepository({
      "2026-12-02": [
        stopTime("a", hours(10)),
        stopTime("b", hours(10.25)),
        stopTime("c", hours(10.5)),
      ],
    });
    const service = new DepartureServiceImpl(
      repository,
      fakeRealtime([{ ...delayed("a", "2026-12-02", 0), canceled: true }]),
    );

    const departures = await service.getDepartures({
      stopId: "s1",
      from: new Date("2026-12-02T09:00:00Z"),
      limit: 2,
    });

    expect(departures.map((d) => d.tripId)).toEqual(["b", "c"]);
  });

  it("matches Trip Updates on the Service Day, not just the Trip", async () => {
    const { repository } = fakeRepository({
      "2026-12-01": [stopTime("t1", hours(24.5))],
      "2026-12-02": [stopTime("t1", hours(0.75))],
    });
    const service = new DepartureServiceImpl(
      repository,
      fakeRealtime([delayed("t1", "2026-12-02", 60)]),
    );

    const departures = await service.getDepartures({
      stopId: "s1",
      from: new Date("2026-12-02T00:00:00Z"),
      limit: 10,
    });

    expect(
      departures.map((d) => [
        d.serviceDate,
        d.predictedDeparture?.toISOString(),
      ]),
    ).toEqual([
      ["2026-12-01", undefined],
      ["2026-12-02", "2026-12-02T00:46:00.000Z"],
    ]);
  });

  it("throws for an unknown Stop", async () => {
    const { repository } = fakeRepository({});
    const service = new DepartureServiceImpl(repository, fakeRealtime());

    await expect(
      service.getDepartures({ stopId: "missing", limit: 10 }),
    ).rejects.toThrow(StopNotFoundError);
  });
});
