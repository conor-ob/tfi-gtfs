import {
  type BuildConfig,
  type DeployConfig,
  defineRailway,
  github,
  group,
  postgres,
  preserve,
  project,
  type ReferencableServiceNode,
  redis,
  service,
  volume,
} from "railway/iac";

function privateNetworkingUrl(target: ReferencableServiceNode) {
  return `http://\${{${target.name}.RAILWAY_PRIVATE_DOMAIN}}:\${{${target.name}.PORT}}`;
}

function dockerBuildConfig({
  dockerfilePath,
  watchPatterns,
}: {
  dockerfilePath: string;
  watchPatterns?: string[];
}): Partial<BuildConfig> {
  return {
    buildEnvironment: "V3",
    builder: "DOCKERFILE",
    dockerfilePath,
    watchPatterns,
  };
}

export default defineRailway(() => {
  // Deploy a commit only once its GitHub checks (CI, Railway apply) pass
  const tfiGtfs = github("conor-ob/tfi-gtfs", {
    checkSuites: true,
  });

  // Railway provisions the database's volume and attaches it; declaring it
  // here adopts it so resizes go through IaC
  const postgresVolume = volume("postgres-volume", {
    allowOnlineResize: true,
    region: "europe-west4-drams3a",
    sizeMB: 5_000,
  });

  const postgresDatabase = postgres("postgres", {
    region: "europe-west4-drams3a",
  });

  // Holds only the latest Trip Updates, which are disposable (see
  // docs/adr/0009)
  const redisDatabase = redis("redis", {
    region: "europe-west4-drams3a",
  });

  const euWest4 = { "europe-west4-drams3a": { numReplicas: 1 } };
  const deployConfig: Partial<DeployConfig> = {
    multiRegionConfig: euWest4,
  };

  // One replica for now. Trip Updates and their refresh cooldown live in
  // Redis, so more would share them (see docs/adr/0009)
  const server = service("server", {
    source: tfiGtfs,
    env: {
      PORT: "8080",
      DATABASE_URL: postgresDatabase.env.DATABASE_URL,
      TRIP_UPDATE_STORE: "redis",
      REDIS_URL: redisDatabase.env.REDIS_URL,
      // Set once in the Railway dashboard and sealed there, never in source
      NTA_API_KEY: preserve(),
    },
    build: dockerBuildConfig({
      dockerfilePath: "apps/server/Dockerfile",
    }),
    preDeploy: "node /app/apps/server/dist/migrate.mjs",
    deploy: {
      ...deployConfig,
      healthcheckPath: "/health",
    },
  });

  // Serves the static build and proxies /api to the server over private
  // networking, so the server needs no public domain and no CORS origin
  const web = service("web", {
    source: tfiGtfs,
    env: {
      PORT: "8080",
      SERVER_URL: privateNetworkingUrl(server),
    },
    build: dockerBuildConfig({
      dockerfilePath: "apps/web/Dockerfile",
    }),
    deploy: {
      ...deployConfig,
      healthcheckPath: "/",
    },
  });

  // The LED board on its own domain, served and proxied like web
  const dartboard = service("dartboard", {
    source: tfiGtfs,
    env: {
      PORT: "8080",
      SERVER_URL: privateNetworkingUrl(server),
    },
    build: dockerBuildConfig({
      dockerfilePath: "apps/dartboard/Dockerfile",
    }),
    deploy: {
      ...deployConfig,
      healthcheckPath: "/",
    },
  });

  // Railway cron is UTC; the Schedule is published around 22:30 UTC
  const scheduleSync = service("schedule-sync", {
    source: tfiGtfs,
    env: {
      DATABASE_URL: postgresDatabase.env.DATABASE_URL,
      // Comma-separated; changing it re-imports at the next run (see
      // docs/adr/0007). Declared here, not in the dashboard, so a change is
      // planned and reviewed like any other
      WATCHED_STOP_IDS: "8250IR0014,8250DB003062,8250IR0111",
    },
    build: dockerBuildConfig({
      dockerfilePath: "jobs/schedule-sync/Dockerfile",
    }),
    deploy: {
      ...deployConfig,
      cronSchedule: "0 4 * * *",
      restartPolicyType: "NEVER",
    },
  });

  const jobs = group("jobs", [scheduleSync]);
  const database = group("database", [
    postgresDatabase,
    postgresVolume,
    redisDatabase,
  ]);
  const backend = group("backend", [server]);
  const frontend = group("frontend", [web, dartboard]);

  return project("tfi-gtfs", {
    resources: [backend, database, frontend, jobs],
  });
});
