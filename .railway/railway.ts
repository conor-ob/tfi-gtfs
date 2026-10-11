import {
  type BuildConfig,
  type DeployConfig,
  defineRailway,
  github,
  group,
  postgres,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

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
  const tfiGtfs = github("conor-ob/tfi-gtfs", {
    checkSuites: false,
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

  const euWest4 = { "europe-west4-drams3a": { numReplicas: 1 } };
  const deployConfig: Partial<DeployConfig> = {
    multiRegionConfig: euWest4,
  };

  // One replica only: the Realtime poller and its Trip Updates live in server
  // memory (see docs/adr/0005)
  const server = service("server", {
    source: tfiGtfs,
    env: {
      PORT: "8080",
      DATABASE_URL: postgresDatabase.env.DATABASE_URL,
      // Set once in the Railway dashboard and sealed there, never in source
      NTA_API_KEY: preserve(),
    },
    build: dockerBuildConfig({
      dockerfilePath: "apps/server/Dockerfile",
    }),
    preDeploy: "node /app/apps/server/dist/migrate.js",
    deploy: {
      ...deployConfig,
      healthcheckPath: "/health",
    },
  });

  // Railway cron is UTC; the Schedule is published around 22:30 UTC
  const scheduleSync = service("schedule-sync", {
    source: tfiGtfs,
    env: {
      DATABASE_URL: postgresDatabase.env.DATABASE_URL,
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
  const database = group("database", [postgresDatabase, postgresVolume]);
  const backend = group("backend", [server]);

  return project("tfi-gtfs", {
    resources: [backend, database, jobs],
  });
});
