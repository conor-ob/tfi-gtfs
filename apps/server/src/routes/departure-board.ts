import {
  type DepartureBoardOptions,
  DepartureBoardSession,
} from "@tfi-gtfs/tfi-gtfs-departure-board";
import type { FastifyInstance } from "fastify";

// The Departure Board's Transit Tracker protocol (see docs/adr/0010). Rate
// limiting applies to the upgrade request only, so open sockets stay open
export default function (
  fastify: FastifyInstance,
  options?: Partial<DepartureBoardOptions>,
) {
  fastify.register(async (instance) => {
    instance.get("/departure-board", { websocket: true }, (socket, request) => {
      const session = new DepartureBoardSession(
        socket,
        fastify.dependencies.departureService,
        request.log,
        options,
      );
      socket.on("message", (data) => session.receive(data.toString()));
      socket.on("close", () => session.close());
    });
  });
}
