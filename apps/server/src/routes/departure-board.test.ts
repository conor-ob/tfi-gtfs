import type { WebSocket } from "@fastify/websocket";
import type { Departure } from "@tfi-gtfs/tfi-gtfs-core";
import type { ServerMessage } from "@tfi-gtfs/tfi-gtfs-departure-board";
import Fastify, { type FastifyInstance } from "fastify";
import { expect, onTestFinished, suite, test } from "vitest";
import registerWebsocketPlugin from "~/plugins/websocket";
import registerDepartureBoardRoute from "~/routes/departure-board";

const departure: Departure = {
  tripId: "t1",
  stopId: "8250IR0014",
  stopName: "Dalkey",
  stopSequence: 1,
  headsign: "Howth",
  directionId: 0,
  routeId: "dart",
  routeShortName: "DART",
  routeLongName: null,
  routeColor: "00A650",
  routeType: 2,
  agencyId: "irish-rail",
  serviceDate: "2026-12-02",
  scheduledDeparture: new Date("2026-12-02T10:10:00Z"),
  predictedDeparture: null,
};

async function createApp() {
  // Only the route under test, with a fake DepartureService instead of the
  // database
  const fastify = Fastify({ logger: false });
  fastify.decorate("dependencies", {
    departureService: { getDepartures: async () => [departure] },
  } as unknown as FastifyInstance["dependencies"]);
  registerWebsocketPlugin(fastify);
  registerDepartureBoardRoute(fastify, {
    heartbeatIntervalMs: 50,
    scheduleIntervalMs: 60_000,
  });
  await fastify.ready();
  onTestFinished(() => fastify.close());
  return fastify;
}

function nextMessage(
  socket: WebSocket,
  event: ServerMessage["event"],
): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer) => {
      const message: ServerMessage = JSON.parse(data.toString());
      if (message.event !== event) return;
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

suite("departure-board/", () => {
  test("sends a schedule on subscribe, and heartbeats", async () => {
    const fastify = await createApp();
    const socket = await fastify.injectWS("/departure-board");
    onTestFinished(() => socket.terminate());

    const schedule = nextMessage(socket, "schedule");
    const heartbeat = nextMessage(socket, "heartbeat");
    socket.send(
      JSON.stringify({
        event: "schedule:subscribe",
        data: {
          feedCode: "",
          routeStopPairs: "*:0,8250IR0014,-300",
          limit: 3,
          sortByDeparture: true,
          listMode: "nextPerRoute",
        },
      }),
    );

    expect(await schedule).toEqual({
      event: "schedule",
      data: {
        trips: [
          {
            tripId: "t1",
            stopId: "8250IR0014",
            routeId: "dart",
            routeName: "DART",
            routeColor: "00A650",
            headsign: "Howth",
            stopName: "Dalkey",
            arrivalTime: 1796206200,
            departureTime: 1796206200,
            isRealtime: false,
            vehicle: null,
          },
        ],
      },
    });
    expect(await heartbeat).toEqual({ event: "heartbeat", data: null });
  });

  test("closes the socket on a malformed schedule string", async () => {
    const fastify = await createApp();
    const socket = await fastify.injectWS("/departure-board");

    const closed = new Promise<number>((resolve) =>
      socket.on("close", (code) => resolve(code)),
    );
    socket.send(
      JSON.stringify({
        event: "schedule:subscribe",
        data: { routeStopPairs: "*,8250IR0014,300", limit: 3 },
      }),
    );

    expect(await closed).toBe(1008);
  });
});
