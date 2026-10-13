import {
  type Departure,
  type DepartureQuery,
  type DepartureService,
  StopNotFoundError,
} from "@tfi-gtfs/tfi-gtfs-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "./protocol";
import { DepartureBoardSession } from "./session";

const NOW = new Date("2026-12-02T10:00:00Z");

const departure = (tripId: string, stopId: string): Departure => ({
  tripId,
  stopId,
  stopName: stopId,
  stopSequence: 1,
  headsign: "Howth",
  directionId: 0,
  routeId: "dart",
  routeShortName: "DART",
  routeLongName: null,
  routeColor: null,
  routeType: 2,
  agencyId: "irish-rail",
  serviceDate: "2026-12-02",
  scheduledDeparture: new Date("2026-12-02T10:10:00Z"),
  predictedDeparture: null,
});

const subscribe = (routeStopPairs: string, limit = 3) =>
  JSON.stringify({
    event: "schedule:subscribe",
    data: {
      feedCode: "",
      routeStopPairs,
      limit,
      sortByDeparture: true,
      listMode: "nextPerRoute",
    },
  });

function setup(
  getDepartures: DepartureService["getDepartures"] = async ({ stopId }) => [
    departure(`t-${stopId}`, stopId),
  ],
) {
  const messages: ServerMessage[] = [];
  const socket = {
    send: (data: string) => messages.push(JSON.parse(data)),
    close: vi.fn(),
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = { getDepartures: vi.fn(getDepartures) };
  const session = new DepartureBoardSession(
    socket,
    service,
    logger,
    { heartbeatIntervalMs: 30_000, scheduleIntervalMs: 30_000 },
    () => new Date(),
  );
  const schedules = () =>
    messages.flatMap((message) =>
      message.event === "schedule"
        ? [message.data.trips.map((trip) => trip.tripId)]
        : [],
    );
  return { session, messages, socket, logger, service, schedules };
}

describe("DepartureBoardSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a schedule straight after subscribe, then every interval", async () => {
    const { session, schedules } = setup();

    session.receive(subscribe("*,s1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(schedules()).toEqual([["t-s1"]]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(schedules()).toHaveLength(2);
    session.close();
  });

  it("sends heartbeats from the start", async () => {
    const { session, messages } = setup();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(messages).toEqual([
      { event: "heartbeat", data: null },
      { event: "heartbeat", data: null },
    ]);
    session.close();
  });

  it("asks for Departures from now plus the Walk Time, in the pair's direction", async () => {
    const { session, service } = setup();

    session.receive(subscribe("*:0,dalkey,-300;*,breffni"));
    await vi.advanceTimersByTimeAsync(0);

    expect(service.getDepartures.mock.calls.map(([query]) => query)).toEqual([
      {
        stopId: "dalkey",
        from: new Date("2026-12-02T10:05:00Z"),
        directionId: 0,
        limit: 50,
      },
      {
        stopId: "breffni",
        from: NOW,
        directionId: undefined,
        limit: 50,
      },
    ] satisfies DepartureQuery[]);
    session.close();
  });

  it("replaces the subscription on a new subscribe", async () => {
    const { session, schedules } = setup();

    session.receive(subscribe("*,s1"));
    session.receive(subscribe("*,s2"));
    await vi.advanceTimersByTimeAsync(30_000);

    // s1's first push is dropped, since it was replaced while reading
    expect(schedules()).toEqual([["t-s2"], ["t-s2"]]);
    session.close();
  });

  it("stops sending once closed", async () => {
    const { session, messages } = setup();

    session.receive(subscribe("*,s1"));
    session.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(messages).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns once per subscribe about a Stop that isn't watched", async () => {
    const { session, logger, schedules } = setup(async ({ stopId }) => {
      if (stopId === "unwatched") throw new StopNotFoundError(stopId);
      return [departure("t1", stopId)];
    });

    session.receive(subscribe("*,unwatched;*,s1"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(schedules()).toEqual([["t1"], ["t1"], ["t1"]]);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    session.receive(subscribe("*,unwatched;*,s1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    session.close();
  });

  it("skips a push when Departures can't be read, and keeps going", async () => {
    let fail = true;
    const { session, logger, messages, schedules } = setup(async () => {
      if (fail) throw new Error("database down");
      return [departure("t1", "s1")];
    });

    session.receive(subscribe("*,s1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(schedules()).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);

    fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(schedules()).toEqual([["t1"]]);
    expect(messages).toContainEqual({ event: "heartbeat", data: null });
    session.close();
  });

  it.each([
    ["a malformed schedule string", subscribe("*,s1,300")],
    ["a limit over 20", subscribe("*,s1", 21)],
    ["an unknown event", JSON.stringify({ event: "hello", data: {} })],
    ["a message that isn't JSON", "{"],
  ])("closes the socket on %s", async (_, raw) => {
    const { session, socket, messages } = setup();

    session.receive(raw);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(messages).toEqual([
      { event: "error", data: { message: expect.any(String) } },
    ]);
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String));
    expect(vi.getTimerCount()).toBe(0);
  });
});
