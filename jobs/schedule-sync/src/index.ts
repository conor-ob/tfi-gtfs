import { GtfsStaticScheduleFeedClient } from "@tfi-gtfs/gtfs-static";
import { injectScheduleImportDependencies } from "@tfi-gtfs/tfi-gtfs-core";
import { injectDependencies as injectDatabaseDependencies } from "@tfi-gtfs/tfi-gtfs-db";
import { env } from "./env/schema";

// Daily Schedule Import: stream the Schedule into a staging schema and swap it
// in (see docs/adr/0002 to 0004). Composition root for the job.
const database = injectDatabaseDependencies();
const { scheduleImportService } = injectScheduleImportDependencies(
  new GtfsStaticScheduleFeedClient(env.SCHEDULE_URL),
  database.scheduleImportRepository,
);

const started = performance.now();
try {
  const result = await scheduleImportService.importSchedule();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  // biome-ignore lint/suspicious/noConsole: job output
  console.log(
    `schedule-sync: ${result.status} ${result.feedVersion} in ${seconds}s`,
  );
  if (result.status === "imported") {
    // biome-ignore lint/suspicious/noConsole: job output
    console.table(result.rowCounts);
  }
} catch (error) {
  // biome-ignore lint/suspicious/noConsole: job output
  console.error("schedule-sync: failed", error);
  process.exitCode = 1;
} finally {
  await database.close();
}
