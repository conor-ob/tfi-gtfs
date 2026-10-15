import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ScheduleStaging,
  ScheduleTableName,
  ScheduleTables,
} from "@tfi-gtfs/tfi-gtfs-core";
import { SqliteScheduleImportRepository } from "../repository/schedule-import-repository";
import { openSchedule, ScheduleDatabase } from "../schedule-database";

export type Rows = { [T in ScheduleTableName]: ScheduleTables[T][] };

export async function* from<T>(rows: Iterable<T>) {
  yield* rows;
}

export async function loadAll(staging: ScheduleStaging, rows: Rows) {
  for (const table of Object.keys(rows) as ScheduleTableName[]) {
    await staging.load(table, from(rows[table] as never[]));
  }
}

/** A temp folder for Schedule files, removed by `cleanup` */
export async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "tfi-gtfs-sqlite-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Builds a Schedule file from fixture rows the way an import does, and opens it */
export async function buildSchedule(rows: Rows) {
  const { dir, cleanup } = await tempDir();
  const path = join(dir, "schedule.sqlite");
  const staging = await new SqliteScheduleImportRepository(
    path,
  ).createStaging();
  await loadAll(staging, rows);
  const problems = await staging.check();
  if (problems.length > 0) throw new Error(problems.join("\n"));
  await staging.build({ feedVersion: "v1", etag: null });
  const schedule = new ScheduleDatabase(openSchedule(path));
  return {
    schedule,
    close: async () => {
      schedule.close();
      await cleanup();
    },
  };
}
