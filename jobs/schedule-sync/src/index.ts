import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GtfsStaticScheduleFeedClient } from "@tfi-gtfs/gtfs-static";
import { injectScheduleImportDependencies } from "@tfi-gtfs/tfi-gtfs-core";
import { createScheduleStore } from "@tfi-gtfs/tfi-gtfs-schedule-store";
import { SqliteScheduleImportRepository } from "@tfi-gtfs/tfi-gtfs-sqlite";
import { env } from "./env/schema";

// Daily Schedule Import: build the whole Schedule as a SQLite file in a temp
// folder, then publish it gzipped to the Schedule store (see docs/adr/0011).
// Composition root for the job.
const scheduleStore = createScheduleStore();
const dir = await mkdtemp(join(tmpdir(), "schedule-sync-"));
const { scheduleImportService } = injectScheduleImportDependencies(
  new GtfsStaticScheduleFeedClient(env.SCHEDULE_URL),
  new SqliteScheduleImportRepository(join(dir, "schedule.sqlite")),
  scheduleStore,
);

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

const started = performance.now();
try {
  const result = await scheduleImportService.importSchedule();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  // biome-ignore lint/suspicious/noConsole: job output
  console.log(
    `schedule-sync: ${result.status} ${result.feedVersion} at ${result.key} in ${seconds}s`,
  );
  if (result.status === "imported") {
    // biome-ignore lint/suspicious/noConsole: job output
    console.log(
      `schedule-sync: ${megabytes(result.sizeBytes)}, ${megabytes(result.gzipBytes)} gzipped`,
    );
    // biome-ignore lint/suspicious/noConsole: job output
    console.table(result.rowCounts);
  }
} catch (error) {
  // biome-ignore lint/suspicious/noConsole: job output
  console.error("schedule-sync: failed", error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
