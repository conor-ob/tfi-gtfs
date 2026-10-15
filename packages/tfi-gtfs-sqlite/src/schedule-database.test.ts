import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ScheduleDatabase } from "./schedule-database";

const versioned = (feedVersion: string) => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE feed_info (feed_version TEXT NOT NULL)");
  database.prepare("INSERT INTO feed_info VALUES (?)").run(feedVersion);
  return database;
};

const FEED_VERSION = "SELECT feed_version FROM feed_info";

describe("ScheduleDatabase", () => {
  it("throws until a Schedule is open", () => {
    expect(() => new ScheduleDatabase().prepare(FEED_VERSION)).toThrow(
      "No Schedule is open",
    );
  });

  it("caches statements per handle and drops them on a swap", () => {
    const first = versioned("v1");
    const schedule = new ScheduleDatabase(first);
    const statement = schedule.prepare(FEED_VERSION);
    expect(schedule.prepare(FEED_VERSION)).toBe(statement);

    expect(schedule.swap(versioned("v2"))).toBe(first);
    first.close();

    // Closing the old handle finalized its statements, which can't be printed
    expect(schedule.prepare(FEED_VERSION) === statement).toBe(false);
    expect(schedule.prepare(FEED_VERSION).get()).toEqual({
      feed_version: "v2",
    });
    schedule.close();
  });
});
