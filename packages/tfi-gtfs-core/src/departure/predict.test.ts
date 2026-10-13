import { describe, expect, it } from "vitest";
import type { StopTimeUpdate, TripUpdate } from "../realtime/domain/types";
import type { Departure } from "./domain/types";
import { predictDeparture } from "./predict";

const departure: Departure = {
  tripId: "t1",
  stopId: "s5",
  stopName: "Westmoreland Street",
  stopSequence: 5,
  headsign: "Dún Laoghaire",
  directionId: 0,
  routeId: "r46a",
  routeShortName: "46A",
  routeLongName: null,
  routeColor: null,
  routeType: 3,
  agencyId: "1",
  serviceDate: "2026-12-02",
  scheduledDeparture: new Date("2026-12-02T10:00:00Z"),
  predictedDeparture: null,
};

const update = (
  stopSequence: number,
  delay: number | null,
  skipped = false,
): StopTimeUpdate => ({
  stopSequence,
  stopId: `s${stopSequence}`,
  skipped,
  delay,
});

const tripUpdate = (
  stopTimeUpdates: StopTimeUpdate[],
  delay: number | null = null,
): TripUpdate => ({
  tripId: "t1",
  startDate: "2026-12-02",
  canceled: false,
  delay,
  stopTimeUpdates,
});

const predicted = (tu: TripUpdate | undefined) =>
  predictDeparture(departure, tu)?.predictedDeparture?.toISOString();

describe("predictDeparture", () => {
  it("leaves a Departure with no Trip Update as scheduled", () => {
    expect(predictDeparture(departure, undefined)).toBe(departure);
  });

  it("applies the Stop's own Delay", () => {
    expect(predicted(tripUpdate([update(3, 60), update(5, 120)]))).toBe(
      "2026-12-02T10:02:00.000Z",
    );
  });

  it("carries the last earlier Delay forward", () => {
    expect(
      predicted(tripUpdate([update(2, 60), update(4, -30), update(7, 300)])),
    ).toBe("2026-12-02T09:59:30.000Z");
  });

  it("falls back to the Trip's Delay before the first Stop Time Update", () => {
    expect(predicted(tripUpdate([update(7, 300)], 90))).toBe(
      "2026-12-02T10:01:30.000Z",
    );
  });

  it("has no Predicted Departure when nothing gives a Delay", () => {
    const result = predictDeparture(departure, tripUpdate([update(7, 300)]));
    expect(result).not.toBeNull();
    expect(result?.predictedDeparture).toBeNull();
  });

  it("removes a cancelled Trip", () => {
    expect(
      predictDeparture(departure, { ...tripUpdate([]), canceled: true }),
    ).toBeNull();
  });

  it("removes a skipped Stop, but not the Stops after a skipped one", () => {
    expect(
      predictDeparture(departure, tripUpdate([update(5, null, true)], 60)),
    ).toBeNull();
    expect(predicted(tripUpdate([update(3, 60), update(4, null, true)]))).toBe(
      "2026-12-02T10:01:00.000Z",
    );
  });
});
