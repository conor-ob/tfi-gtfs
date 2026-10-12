import { NtaRealtimeFeedClient } from "@tfi-gtfs/gtfs-realtime";
import {
  InMemoryTripUpdateStore,
  injectDependencies as injectCoreDependencies,
  type TripUpdateStore,
} from "@tfi-gtfs/tfi-gtfs-core";
import { injectDependencies as injectDatabaseDependencies } from "@tfi-gtfs/tfi-gtfs-db";
import {
  createRedisClient,
  RedisTripUpdateStore,
} from "@tfi-gtfs/tfi-gtfs-redis";
import type { FastifyInstance } from "fastify";
import { env } from "~/env/schema";

declare module "fastify" {
  interface FastifyInstance {
    dependencies: ReturnType<typeof injectCoreDependencies>;
  }
}

export default function (fastify: FastifyInstance) {
  const databaseDependencies = injectDatabaseDependencies();
  const { tripUpdateStore, close } = createTripUpdateStore(fastify);
  const coreDependencies = injectCoreDependencies(
    databaseDependencies.departureRepository,
    databaseDependencies.stopRepository,
    new NtaRealtimeFeedClient(env.REALTIME_URL, env.NTA_API_KEY),
    tripUpdateStore,
    {
      refreshIntervalMs: env.REALTIME_REFRESH_INTERVAL_SECONDS * 1000,
      onError: (error) =>
        fastify.log.warn(error, "Failed to read or store Trip Updates"),
    },
  );

  fastify.decorate("dependencies", coreDependencies);
  fastify.addHook("onClose", close);
}

function createTripUpdateStore(fastify: FastifyInstance): {
  tripUpdateStore: TripUpdateStore;
  close: () => Promise<void>;
} {
  if (env.TRIP_UPDATE_STORE === "memory" || !env.REDIS_URL) {
    return {
      tripUpdateStore: new InMemoryTripUpdateStore(),
      close: async () => {},
    };
  }
  const client = createRedisClient(env.REDIS_URL, (error) =>
    fastify.log.warn(error, "Redis connection error"),
  );
  return {
    tripUpdateStore: new RedisTripUpdateStore(client),
    close: async () => client.destroy(),
  };
}
