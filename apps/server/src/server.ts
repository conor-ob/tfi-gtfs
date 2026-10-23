import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import Fastify from "fastify";

import registerLoggerPlugin from "~/plugins/logger";
import registerModulePlugin, { type ModuleOptions } from "~/plugins/module";
import registerRateLimitPlugin from "~/plugins/ratelimit";
import registerTrpcPlugin from "~/plugins/trpc";
import registerWebsocketPlugin from "~/plugins/websocket";
import registerDepartureBoardRoute from "~/routes/departure-board";
import registerHealthCheckRoute from "~/routes/health";

export function createServer(
  opts?: FastifyServerOptions,
  moduleOptions?: ModuleOptions,
) {
  const fastify: FastifyInstance<Server, IncomingMessage, ServerResponse> =
    Fastify(opts);

  registerLoggerPlugin(fastify);
  registerRateLimitPlugin(fastify);
  registerModulePlugin(fastify, moduleOptions);
  registerWebsocketPlugin(fastify);
  registerTrpcPlugin(fastify);
  registerDepartureBoardRoute(fastify);
  registerHealthCheckRoute(fastify);

  return fastify;
}
