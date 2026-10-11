import {
  type AppRouter,
  appRouter,
  createTrpcContext,
} from "@tfi-gtfs/tfi-gtfs-trpc";
import type { FastifyTRPCPluginOptions } from "@trpc/server/adapters/fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import type { FastifyInstance } from "fastify";

export default function (fastify: FastifyInstance) {
  fastify.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext() {
        return createTrpcContext({
          departureService: fastify.dependencies.departureService,
          stopService: fastify.dependencies.stopService,
        });
      },
      onError({ path, type, error }) {
        fastify.log.error(
          error,
          `Error in tRPC ${type} handler on path '${path}': ${error.message}`,
        );
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
  });
}
