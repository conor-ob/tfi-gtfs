import { injectDependencies as injectCoreDependencies } from "@tfi-gtfs/tfi-gtfs-core";
import { injectDependencies as injectDatabaseDependencies } from "@tfi-gtfs/tfi-gtfs-db";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    dependencies: ReturnType<typeof injectCoreDependencies>;
  }
}

export default function (fastify: FastifyInstance) {
  const _databaseDependencies = injectDatabaseDependencies();
  const coreDependencies = injectCoreDependencies();

  fastify.decorate("dependencies", coreDependencies);
}
