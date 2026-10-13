import type { Departure } from "@tfi-gtfs/tfi-gtfs-core";
import { describe, expect, it } from "vitest";
import type { RouteStopPair } from "./route-stop-pairs";
import { selectTrips, toTrip } from "./trips";

const departure = (
  tripId: string,
  scheduledDeparture: string,
  overrides: Partial<Departure> = {},
): Departure => ({
  tripId,
  stopId: "dalkey",
  stopName: "Dalkey",
  stopSequence: 1,
  headsign: "Howth",
  directionId: 0,
  routeId: "dart",
  routeShortName: "DART",
  routeLongName: "Bray - Howth",
  routeColor: "00A650",
  routeTextColor: null,
  routeType: 2,
  agencyId: "irish-rail",
  serviceDate: "2026-12-02",
  scheduledDeparture: new Date(scheduledDeparture),
  predictedDeparture: null,
  ...overrides,
});

const anyRoute = (stopId: string): RouteStopPair => ({
  routeId: null,
  stopId,
  walkTimeSeconds: 0,
});

describe("toTrip", () => {
  it("maps a scheduled Departure", () => {
    expect(toTrip(departure("t1", "2026-12-02T10:00:00Z"))).toEqual({
      tripId: "t1",
      stopId: "dalkey",
      routeId: "dart",
      routeName: "DART",
      routeColor: "00A650",
      headsign: "Howth",
      stopName: "Dalkey",
      arrivalTime: 1796205600,
      departureTime: 1796205600,
      isRealtime: false,
      vehicle: null,
    });
  });

  it("uses the Predicted Departure when there is one", () => {
    const trip = toTrip(
      departure("t1", "2026-12-02T10:00:00Z", {
        predictedDeparture: new Date("2026-12-02T10:02:00Z"),
      }),
    );

    expect(trip).toMatchObject({
      arrivalTime: 1796205720,
      departureTime: 1796205720,
      isRealtime: true,
    });
  });

  it("falls back when names and colours are missing", () => {
    const trip = toTrip(
      departure("t1", "2026-12-02T10:00:00Z", {
        routeShortName: null,
        routeLongName: null,
        routeColor: "",
        headsign: null,
      }),
    );

    expect(trip).toMatchObject({
      routeName: "dart",
      routeColor: null,
      headsign: "",
    });
  });
});

describe("selectTrips", () => {
  it("filters each pair by its route", () => {
    const trips = selectTrips(
      [
        {
          pair: { routeId: "46a", stopId: "breffni", walkTimeSeconds: 0 },
          departures: [
            departure("a", "2026-12-02T10:00:00Z", { routeId: "46a" }),
            departure("b", "2026-12-02T10:01:00Z", { routeId: "7" }),
          ],
        },
      ],
      { listMode: "sequential", limit: 5 },
    );

    expect(trips.map((trip) => trip.tripId)).toEqual(["a"]);
  });

  it("merges pairs soonest first, by Predicted Departure", () => {
    const trips = selectTrips(
      [
        {
          pair: anyRoute("dalkey"),
          departures: [
            departure("dart-late", "2026-12-02T10:00:00Z", {
              predictedDeparture: new Date("2026-12-02T10:10:00Z"),
            }),
            departure("dart-next", "2026-12-02T10:20:00Z"),
          ],
        },
        {
          pair: anyRoute("breffni"),
          departures: [
            departure("bus", "2026-12-02T10:05:00Z", { stopId: "breffni" }),
          ],
        },
      ],
      { listMode: "sequential", limit: 5 },
    );

    expect(trips.map((trip) => trip.tripId)).toEqual([
      "bus",
      "dart-late",
      "dart-next",
    ]);
  });

  it("de-duplicates a Departure read for two pairs at one Stop", () => {
    const shared = departure("t1", "2026-12-02T10:00:00Z");
    const trips = selectTrips(
      [
        { pair: anyRoute("dalkey"), departures: [shared] },
        {
          pair: { routeId: "dart", stopId: "dalkey", walkTimeSeconds: 0 },
          departures: [shared],
        },
      ],
      { listMode: "sequential", limit: 5 },
    );

    expect(trips).toHaveLength(1);
  });

  it("keeps the same Trip on two Service Days", () => {
    const trips = selectTrips(
      [
        {
          pair: anyRoute("dalkey"),
          departures: [
            departure("daily", "2026-12-02T23:00:00Z"),
            departure("daily", "2026-12-03T23:00:00Z", {
              serviceDate: "2026-12-03",
            }),
          ],
        },
      ],
      { listMode: "sequential", limit: 5 },
    );

    expect(trips).toHaveLength(2);
  });

  it("takes the first `limit` in sequential mode", () => {
    const trips = selectTrips(
      [
        {
          pair: anyRoute("dalkey"),
          departures: [
            departure("a", "2026-12-02T10:00:00Z"),
            departure("b", "2026-12-02T10:10:00Z"),
            departure("c", "2026-12-02T10:20:00Z"),
          ],
        },
      ],
      { listMode: "sequential", limit: 2 },
    );

    expect(trips.map((trip) => trip.tripId)).toEqual(["a", "b"]);
  });

  it("keeps one row per Stop, Route and direction in nextPerRoute mode", () => {
    const trips = selectTrips(
      [
        {
          pair: anyRoute("dalkey"),
          departures: [
            departure("north-1", "2026-12-02T10:00:00Z"),
            departure("south-1", "2026-12-02T10:02:00Z", { directionId: 1 }),
            departure("north-2", "2026-12-02T10:10:00Z"),
          ],
        },
        {
          pair: anyRoute("breffni"),
          departures: [
            departure("7-1", "2026-12-02T10:01:00Z", {
              stopId: "breffni",
              routeId: "7",
            }),
            departure("7-2", "2026-12-02T10:03:00Z", {
              stopId: "breffni",
              routeId: "7",
            }),
            // The same Route as Dalkey, at another Stop
            departure("dart-breffni", "2026-12-02T10:04:00Z", {
              stopId: "breffni",
            }),
          ],
        },
      ],
      { listMode: "nextPerRoute", limit: 3 },
    );

    expect(trips.map((trip) => trip.tripId)).toEqual([
      "north-1",
      "7-1",
      "south-1",
    ]);
  });

  it("returns nothing for pairs without Departures", () => {
    expect(
      selectTrips([{ pair: anyRoute("unwatched"), departures: [] }], {
        listMode: "nextPerRoute",
        limit: 3,
      }),
    ).toEqual([]);
  });
});
