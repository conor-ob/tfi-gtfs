import { describe, expect, it } from "vitest";
import { parseRouteStopPairs, RouteStopPairsError } from "./route-stop-pairs";

describe("parseRouteStopPairs", () => {
  it("parses the README example", () => {
    expect(
      parseRouteStopPairs("*:0,8250IR0014,-300;*,8250DB003062,-240"),
    ).toEqual([
      {
        routeId: null,
        directionId: 0,
        stopId: "8250IR0014",
        walkTimeSeconds: 300,
      },
      { routeId: null, stopId: "8250DB003062", walkTimeSeconds: 240 },
    ]);
  });

  it("reads * as every Route", () => {
    expect(parseRouteStopPairs("*,s1")).toEqual([
      { routeId: null, stopId: "s1", walkTimeSeconds: 0 },
    ]);
  });

  it("keeps the spaces in a route_id", () => {
    expect(parseRouteStopPairs("3 59 d a,s1,-60")).toEqual([
      { routeId: "3 59 d a", stopId: "s1", walkTimeSeconds: 60 },
    ]);
  });

  it("splits a direction off a route_id with spaces", () => {
    expect(parseRouteStopPairs("3 59 d a:1,s1")).toEqual([
      { routeId: "3 59 d a", directionId: 1, stopId: "s1", walkTimeSeconds: 0 },
    ]);
  });

  it("splits the direction at the last colon", () => {
    expect(parseRouteStopPairs("a:b:0,s1")).toEqual([
      { routeId: "a:b", directionId: 0, stopId: "s1", walkTimeSeconds: 0 },
    ]);
  });

  it("treats a missing offset as no Walk Time", () => {
    expect(parseRouteStopPairs("*,s1")[0]?.walkTimeSeconds).toBe(0);
    expect(parseRouteStopPairs("*,s1,0")[0]?.walkTimeSeconds).toBe(0);
    expect(parseRouteStopPairs("*,s1,-0")[0]?.walkTimeSeconds).toBe(0);
  });

  it.each([
    ["an empty string", ""],
    ["a positive offset", "*,s1,300"],
    ["a fractional offset", "*,s1,-1.5"],
    ["a non-numeric offset", "*,s1,soon"],
    ["an empty offset", "*,s1,"],
    ["a missing stop", "*"],
    ["an empty stop", "*,"],
    ["an empty route", ",s1"],
    ["a direction alone", ":0,s1"],
    ["a direction other than 0 or 1", "*:2,s1"],
    ["an empty direction", "*:,s1"],
    ["too many fields", "*,s1,-60,extra"],
    ["an empty pair", "*,s1;"],
    ["garbage", "🚌🚌🚌"],
  ])("rejects %s", (_, value) => {
    expect(() => parseRouteStopPairs(value)).toThrow(RouteStopPairsError);
  });
});
