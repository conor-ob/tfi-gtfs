import {
  type Departure,
  type DepartureService,
  StopNotFoundError,
} from "@tfi-gtfs/tfi-gtfs-core";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { appRouter } from "../trpc/api";
import { createCallerFactory, createTrpcContext } from "../trpc/router";

const createCaller = createCallerFactory(appRouter);

function callerWith(getDepartures: DepartureService["getDepartures"]) {
  return createCaller(
    createTrpcContext({
      departureService: { getDepartures },
      stopService: { getNearbyStops: async () => [] },
    }),
  );
}

describe("departuresRouter", () => {
  it("passes the query to the service with a default limit", async () => {
    const getDepartures = vi.fn(async (): Promise<Departure[]> => []);
    const from = new Date("2026-12-02T10:00:00Z");

    await callerWith(getDepartures).departures.getByStop({
      stopId: "s1",
      from,
    });

    expect(getDepartures).toHaveBeenCalledWith({
      stopId: "s1",
      from,
      limit: 10,
    });
  });

  it("returns NOT_FOUND for an unknown Stop", async () => {
    const caller = callerWith(async () => {
      throw new StopNotFoundError("missing");
    });

    await expect(
      caller.departures.getByStop({ stopId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a limit over 50", async () => {
    const caller = callerWith(async () => []);

    await expect(
      caller.departures.getByStop({ stopId: "s1", limit: 51 }),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});
