import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ScheduleHashMismatchError } from "@tfi-gtfs/tfi-gtfs-core";
import {
  SCHEDULE_SCHEMA_VERSION,
  ScheduleDatabase,
  SqliteDepartureRepository,
} from "@tfi-gtfs/tfi-gtfs-sqlite";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleLoader } from "~/schedule/schedule-loader";
import { DALKEY, tempScheduleStore } from "~/test/schedule";

const feedVersionOf = (schedule: ScheduleDatabase) =>
  (
    schedule.prepare("SELECT feed_version FROM feed_info").get() as {
      feed_version: string;
    }
  ).feed_version;

describe("ScheduleLoader against FsScheduleStore", () => {
  let fixture: Awaited<ReturnType<typeof tempScheduleStore>>;
  let dir: string;
  let schedule: ScheduleDatabase;
  let loader: ScheduleLoader;

  beforeEach(async () => {
    fixture = await tempScheduleStore();
    dir = join(fixture.root, "disk");
    await mkdir(dir);
    schedule = new ScheduleDatabase();
    loader = new ScheduleLoader({
      store: fixture.store,
      schedule,
      schemaVersion: SCHEDULE_SCHEMA_VERSION,
      pollIntervalMs: 60_000,
      log: pino({ level: "silent" }),
      dir,
    });
  });

  afterEach(async () => {
    await loader.close();
    await fixture.cleanup();
  });

  it("stays closed while nothing is published", async () => {
    expect(await loader.refresh()).toBeNull();
    expect(loader.isOpen).toBe(false);
  });

  it("opens the published file", async () => {
    await fixture.publish("fv1");

    expect(await loader.refresh()).toMatchObject({ feedVersion: "fv1" });
    expect(loader.isOpen).toBe(true);
    expect(feedVersionOf(schedule)).toBe("fv1");
    expect(await readdir(dir)).toEqual(["fv1.sqlite"]);
  });

  it("keeps the open file while the pointer hasn't moved", async () => {
    await fixture.publish("fv1");
    await loader.refresh();
    const statement = schedule.prepare("SELECT 1");

    await loader.refresh();

    expect(schedule.prepare("SELECT 1")).toBe(statement);
  });

  it("swaps to a new file and deletes the old one", async () => {
    await fixture.publish("fv1");
    await loader.refresh();
    await fixture.publish("fv2");

    expect(await loader.refresh()).toMatchObject({ feedVersion: "fv2" });
    expect(feedVersionOf(schedule)).toBe("fv2");
    expect(loader.feedVersion).toBe("fv2");
    expect(await readdir(dir)).toEqual(["fv2.sqlite"]);
  });

  it("keeps the old file when the new one's hash doesn't match", async () => {
    await fixture.publish("fv1");
    await loader.refresh();
    const pointer = await fixture.publish("fv2");
    // Corrupt the object after the pointer was written
    await writeFile(
      join(fixture.root, "bucket", ...pointer.key.split("/")),
      gzipSync("not the published file"),
    );

    await expect(loader.refresh()).rejects.toBeInstanceOf(
      ScheduleHashMismatchError,
    );
    expect(feedVersionOf(schedule)).toBe("fv1");
    expect(await readdir(dir)).toEqual(["fv1.sqlite"]);
  });

  it("answers every query during a swap", async () => {
    await fixture.publish("fv1");
    await loader.refresh();
    await fixture.publish("fv2");
    const departures = new SqliteDepartureRepository(schedule);
    const seen = new Set<string>();
    let queries = 0;
    let running = true;

    const traffic = (async () => {
      while (running) {
        const stopTimes = await departures.findScheduledStopTimes({
          stopId: DALKEY.stopId,
          serviceDate: "2026-12-02",
          fromTime: 0,
          toTime: 86_400,
          limit: 10,
        });
        expect(stopTimes).toHaveLength(2);
        seen.add(feedVersionOf(schedule));
        queries++;
        // Yield, as request handling would, so the download makes progress
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await loader.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    running = false;
    await traffic;

    expect(queries).toBeGreaterThan(1);
    expect([...seen]).toEqual(["fv1", "fv2"]);
  });
});
