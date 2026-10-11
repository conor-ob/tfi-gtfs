import { NtaRealtimeFeedClient } from "@tfi-gtfs/gtfs-realtime";
import {
  InMemoryTripUpdateStore,
  injectDependencies as injectCoreDependencies,
} from "@tfi-gtfs/tfi-gtfs-core";
import { injectDependencies as injectDatabaseDependencies } from "@tfi-gtfs/tfi-gtfs-db";
import type { FastifyInstance } from "fastify";
import { env } from "~/env/schema";

declare module "fastify" {
  interface FastifyInstance {
    dependencies: ReturnType<typeof injectCoreDependencies>;
  }
}

export default function (fastify: FastifyInstance) {
  const databaseDependencies = injectDatabaseDependencies();
  // The server is the only Realtime poller (see docs/adr/0005)
  const coreDependencies = injectCoreDependencies(
    databaseDependencies.departureRepository,
    databaseDependencies.stopRepository,
    new NtaRealtimeFeedClient(env.REALTIME_URL, env.NTA_API_KEY),
    new InMemoryTripUpdateStore(),
    {
      pollIntervalMs: env.REALTIME_POLL_INTERVAL_SECONDS * 1000,
      onError: (error) =>
        fastify.log.warn(error, "Failed to read the Realtime Feed"),
    },
  );

  fastify.decorate("dependencies", coreDependencies);
  fastify.addHook("onClose", async () => {
    coreDependencies.realtimeService.stop();
  });
}
