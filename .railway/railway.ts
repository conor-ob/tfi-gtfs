import {
  type BuildConfig,
  bucket,
  type DeployConfig,
  defineRailway,
  github,
  group,
  preserve,
  project,
  type RailwayProvidedVariable,
  type ReferencableServiceNode,
  redis,
  ref,
  service,
} from "railway/iac";

function railwayPrivateNetworkingUrl(
  target: ReferencableServiceNode<RailwayProvidedVariable>,
): string {
  return `http://${toReferenceSyntax(target, "RAILWAY_PRIVATE_DOMAIN")}:${toReferenceSyntax(target, "PORT")}`;
}

// The SDK only supports whole-value references, so use Railway's
// `${{service.VAR}}` syntax to compose them into a string.
function toReferenceSyntax<K extends string>(
  target: ReferencableServiceNode<K>,
  variable: NoInfer<K>,
): string {
  return `\${{${target.name}.${variable}}}`;
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

  // Holds only the latest Trip Updates, which are disposable (see
  // docs/adr/0009)
  const redisDatabase = redis("redis", {
    region: "europe-west4-drams3a",
  });

  // One SQLite file per Feed Version and the `latest.json` pointer, in
  // Amsterdam, next to europe-west4 (see docs/adr/0011)
  const scheduleBucket = bucket("schedule", { region: "ams" });
  const scheduleBucketEnv = {
    SCHEDULE_STORE: "s3",
    SCHEDULE_BUCKET_ENDPOINT: ref(scheduleBucket, "ENDPOINT"),
    SCHEDULE_BUCKET_REGION: ref(scheduleBucket, "REGION"),
    SCHEDULE_BUCKET_NAME: ref(scheduleBucket, "BUCKET"),
    SCHEDULE_BUCKET_ACCESS_KEY_ID: ref(scheduleBucket, "ACCESS_KEY_ID"),
    SCHEDULE_BUCKET_SECRET_ACCESS_KEY: ref(scheduleBucket, "SECRET_ACCESS_KEY"),
  };

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
      ...scheduleBucketEnv,
      SCHEDULE_POLL_INTERVAL_SECONDS: "300",
      REALTIME_URL: "https://api.nationaltransport.ie/gtfsr/v2/TripUpdates",
      REALTIME_REFRESH_INTERVAL_SECONDS: "60",
      TRIP_UPDATE_STORE: "redis",
      REDIS_URL: redisDatabase.env.REDIS_URL,
      // Set once in the Railway dashboard and sealed there, never in source
      NTA_API_KEY: preserve(),
    },
    build: dockerBuildConfig({
      dockerfilePath: "apps/server/Dockerfile",
    }),
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
      SERVER_URL: railwayPrivateNetworkingUrl(server),
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
      SERVER_URL: railwayPrivateNetworkingUrl(server),
    },
    build: dockerBuildConfig({
      dockerfilePath: "apps/dartboard/Dockerfile",
    }),
    deploy: {
      ...deployConfig,
      healthcheckPath: "/",
    },
  });

  // Railway cron is UTC, so this is 03:00 in Irish winter and 04:00 in
  // summer; the Schedule is published around 22:30 UTC
  const scheduleSync = service("schedule-sync", {
    source: tfiGtfs,
    env: {
      ...scheduleBucketEnv,
      SCHEDULE_URL:
        "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip",
      IAC_SMOKE_TEST: "1",
    },
    build: dockerBuildConfig({
      dockerfilePath: "jobs/schedule-sync/Dockerfile",
    }),
    deploy: {
      ...deployConfig,
      cronSchedule: "0 3 * * *",
      restartPolicyType: "NEVER",
    },
  });

  const jobs = group("jobs", [scheduleSync]);
  const database = group("database", [redisDatabase, scheduleBucket]);
  const backend = group("backend", [server]);
  const frontend = group("frontend", [web, dartboard]);

  return project("tfi-gtfs", {
    resources: [backend, database, frontend, jobs],
  });
});
