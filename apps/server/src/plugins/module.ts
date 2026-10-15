import { NtaRealtimeFeedClient } from "@tfi-gtfs/gtfs-realtime";
import {
  InMemoryTripUpdateStore,
  injectDependencies as injectCoreDependencies,
  type ScheduleStore,
  type TripUpdateStore,
} from "@tfi-gtfs/tfi-gtfs-core";
import {
  createRedisClient,
  RedisTripUpdateStore,
} from "@tfi-gtfs/tfi-gtfs-redis";
import { createScheduleStore } from "@tfi-gtfs/tfi-gtfs-schedule-store";
import {
  SCHEDULE_SCHEMA_VERSION,
  ScheduleDatabase,
  SqliteDepartureRepository,
  SqliteStopRepository,
} from "@tfi-gtfs/tfi-gtfs-sqlite";
import type { FastifyInstance } from "fastify";
import { env } from "~/env/schema";
import { ScheduleLoader } from "~/schedule/schedule-loader";

declare module "fastify" {
  interface FastifyInstance {
    dependencies: ReturnType<typeof injectCoreDependencies>;
    scheduleLoader: ScheduleLoader;
  }
}

export type ModuleOptions = {
  /** Defaults to the store `SCHEDULE_STORE` picks */
  scheduleStore?: ScheduleStore;
};

export default function (
  fastify: FastifyInstance,
  { scheduleStore = createScheduleStore() }: ModuleOptions = {},
) {
  // The open Schedule file, swapped by the loader when a new one is published
  const schedule = new ScheduleDatabase();
  const scheduleLoader = new ScheduleLoader({
    store: scheduleStore,
    schedule,
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    pollIntervalMs: env.SCHEDULE_POLL_INTERVAL_SECONDS * 1000,
    log: fastify.log,
  });
  const { tripUpdateStore, close } = createTripUpdateStore(fastify);
  const coreDependencies = injectCoreDependencies(
    new SqliteDepartureRepository(schedule),
    new SqliteStopRepository(schedule),
    new NtaRealtimeFeedClient(env.REALTIME_URL, env.NTA_API_KEY),
    tripUpdateStore,
    {
      refreshIntervalMs: env.REALTIME_REFRESH_INTERVAL_SECONDS * 1000,
      onError: (error) =>
        fastify.log.warn(error, "Failed to read or store Trip Updates"),
    },
  );

  fastify.decorate("dependencies", coreDependencies);
  fastify.decorate("scheduleLoader", scheduleLoader);
  // /health stays 503 until the first file is open
  fastify.addHook("onReady", async () => scheduleLoader.start());
  fastify.addHook("onClose", async () => {
    await scheduleLoader.close();
    await close();
  });
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
