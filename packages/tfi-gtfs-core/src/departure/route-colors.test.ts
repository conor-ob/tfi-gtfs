import { describe, expect, it } from "vitest";
import type { Departure } from "./domain/types";
import { withRouteColors } from "./route-colors";

const departure: Departure = {
  tripId: "t1",
  stopId: "s1",
  stopName: "Parnell Square",
  stopSequence: 1,
  headsign: "Dún Laoghaire",
  directionId: 0,
  routeId: "r46a",
  routeShortName: "46A",
  routeLongName: null,
  routeColor: null,
  routeTextColor: null,
  routeType: 3,
  agencyId: "1",
  serviceDate: "2026-12-02",
  scheduledDeparture: new Date("2026-12-02T10:00:00Z"),
  predictedDeparture: null,
};

describe("withRouteColors", () => {
  it("keeps the feed's colours", () => {
    const colored = {
      ...departure,
      routeColor: "FFD400",
      routeTextColor: "111111",
    };

    expect(withRouteColors(colored)).toStrictEqual(colored);
  });

  it("fills empty colours from the Agency", () => {
    expect(withRouteColors(departure)).toMatchObject({
      routeColor: "F3C936",
      routeTextColor: "000000",
    });
    expect(
      withRouteColors({ ...departure, agencyId: "IR", routeColor: "" }),
    ).toMatchObject({ routeColor: "2F8539", routeTextColor: "FFFFFF" });
  });

  it("fills only the colour that is empty", () => {
    expect(
      withRouteColors({ ...departure, routeColor: "FFD400" }),
    ).toMatchObject({ routeColor: "FFD400", routeTextColor: "000000" });
  });

  it("leaves an unknown Agency's colours null", () => {
    expect(
      withRouteColors({ ...departure, agencyId: "unknown" }),
    ).toMatchObject({ routeColor: null, routeTextColor: null });
  });
});
