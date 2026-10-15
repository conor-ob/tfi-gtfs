import type { FastifyInstance } from "fastify";
import superjson from "superjson";
import { afterAll, beforeAll, expect, suite, test } from "vitest";

import { createServer } from "~/server";
import { BRAY, DALKEY, tempScheduleStore } from "~/test/schedule";

let fixture: Awaited<ReturnType<typeof tempScheduleStore>>;
let fastify: FastifyInstance;

async function query<T>(path: string, input: unknown): Promise<T> {
  const response = await fastify.inject({
    method: "GET",
    url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`,
  });
  expect(response.statusCode, response.body).toEqual(200);
  return superjson.deserialize(response.json().result.data);
}

const from = new Date("2026-12-02T10:00:00Z");

suite("trpc/ over a fixture Schedule", () => {
  beforeAll(async () => {
    fixture = await tempScheduleStore();
    await fixture.publish("fv1");
    fastify = createServer({ logger: false }, { scheduleStore: fixture.store });
    await fastify.ready();
    await fastify.scheduleLoader.refresh();
  });

  afterAll(async () => {
    await fastify.close();
    await fixture.cleanup();
  });

  test("departures.getByStop at a Watched Stop", async () => {
    const departures = await query("departures.getByStop", {
      stopId: DALKEY.stopId,
      from,
    });

    expect(departures).toEqual([
      {
        tripId: "north",
        stopId: DALKEY.stopId,
        stopName: "Dalkey",
        stopSequence: 2,
        headsign: "Howth",
        directionId: 0,
        routeId: "dart",
        routeShortName: "DART",
        routeLongName: "Howth - Greystones",
        routeColor: "00A650",
        routeTextColor: "FFFFFF",
        routeType: 2,
        agencyId: "IR",
        serviceDate: "2026-12-02",
        scheduledDeparture: new Date("2026-12-02T10:45:00Z"),
        predictedDeparture: null,
      },
      expect.objectContaining({
        tripId: "south",
        directionId: 1,
        headsign: "Greystones",
        scheduledDeparture: new Date("2026-12-02T11:00:00Z"),
      }),
    ]);
  });

  test("departures.getByStop at a Stop that was never watched", async () => {
    const departures = await query<{ tripId: string; stopName: string }[]>(
      "departures.getByStop",
      { stopId: BRAY.stopId, from, directionId: 0 },
    );

    expect(departures).toEqual([
      expect.objectContaining({
        tripId: "north",
        stopName: "Bray Daly",
        scheduledDeparture: new Date("2026-12-02T10:30:00Z"),
      }),
    ]);
  });

  test("stops.getNearby searches every Stop", async () => {
    const stops = await query<{ stopId: string; distance: number }[]>(
      "stops.getNearby",
      { lat: 53.2045, lon: -6.1009, radius: 500 },
    );

    expect(stops).toEqual([{ ...BRAY, distance: expect.closeTo(26, 0) }]);
  });

  test("an unknown Stop is NOT_FOUND", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: `/trpc/departures.getByStop?input=${encodeURIComponent(JSON.stringify(superjson.serialize({ stopId: "missing", from })))}`,
    });

    expect(response.statusCode).toEqual(404);
  });
});
