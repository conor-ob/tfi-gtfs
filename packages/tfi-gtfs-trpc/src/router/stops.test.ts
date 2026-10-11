import type { NearbyStop, StopService } from "@tfi-gtfs/tfi-gtfs-core";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { appRouter } from "../trpc/api";
import { createCallerFactory, createTrpcContext } from "../trpc/router";

const createCaller = createCallerFactory(appRouter);

function callerWith(getNearbyStops: StopService["getNearbyStops"]) {
  return createCaller(
    createTrpcContext({
      departureService: { getDepartures: async () => [] },
      stopService: { getNearbyStops },
    }),
  );
}

describe("stopsRouter", () => {
  it("passes the query to the service with a default radius and limit", async () => {
    const getNearbyStops = vi.fn(async (): Promise<NearbyStop[]> => []);

    await callerWith(getNearbyStops).stops.getNearby({
      lat: 53.3473,
      lon: -6.2591,
    });

    expect(getNearbyStops).toHaveBeenCalledWith({
      lat: 53.3473,
      lon: -6.2591,
      radius: 500,
      limit: 10,
    });
  });

  it("rejects coordinates off the globe", async () => {
    const caller = callerWith(async () => []);

    await expect(
      caller.stops.getNearby({ lat: 91, lon: 0 }),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      caller.stops.getNearby({ lat: 0, lon: -181 }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("rejects a radius over 2 km", async () => {
    const caller = callerWith(async () => []);

    await expect(
      caller.stops.getNearby({ lat: 53.3473, lon: -6.2591, radius: 2001 }),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});
