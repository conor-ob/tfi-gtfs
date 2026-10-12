import type { TripUpdate, TripUpdateFeed } from "@tfi-gtfs/tfi-gtfs-core";
import { createClient, type RedisClientType } from "redis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RedisTripUpdateStore } from "./redis-trip-update-store";

const tripUpdate = (tripId: string, delay = 60): TripUpdate => ({
  tripId,
  startDate: "2026-12-02",
  canceled: false,
  delay,
  stopTimeUpdates: [{ stopSequence: 3, stopId: "s1", skipped: false, delay }],
});

const feed = (...tripUpdates: TripUpdate[]): TripUpdateFeed => ({
  timestamp: new Date("2026-12-02T10:00:00Z"),
  tripUpdates,
});

const inAMinute = () => new Date(Date.now() + 60_000);

describe("RedisTripUpdateStore", () => {
  let client: RedisClientType;
  let store: RedisTripUpdateStore;

  beforeAll(async () => {
    client = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
    await client.connect();
    store = new RedisTripUpdateStore(client);
  });

  beforeEach(async () => {
    await client.flushDb();
  });

  afterAll(async () => {
    await client.close();
  });

  it("has no snapshot until one is stored", async () => {
    expect(await store.getTripUpdates(["2026-12-02/t1"])).toBeNull();
  });

  it("returns only the asked-for Trip Updates that exist", async () => {
    await store.replace(feed(tripUpdate("t1"), tripUpdate("t2")), inAMinute());

    const snapshot = await store.getTripUpdates([
      "2026-12-02/t1",
      "2026-12-02/missing",
    ]);

    expect(snapshot).toEqual({
      timestamp: new Date("2026-12-02T10:00:00Z"),
      tripUpdates: new Map([["2026-12-02/t1", tripUpdate("t1")]]),
    });
  });

  it("answers an empty question with just the timestamp", async () => {
    await store.replace(feed(tripUpdate("t1")), inAMinute());

    const snapshot = await store.getTripUpdates([]);

    expect(snapshot?.tripUpdates.size).toBe(0);
  });

  it("stores an empty feed as a snapshot with no Trip Updates", async () => {
    await store.replace(feed(tripUpdate("t1")), inAMinute());
    await store.replace(feed(), inAMinute());

    const snapshot = await store.getTripUpdates(["2026-12-02/t1"]);

    expect(snapshot?.tripUpdates.size).toBe(0);
  });

  it("replaces the whole snapshot, dropping Trips no longer in the feed", async () => {
    await store.replace(feed(tripUpdate("t1"), tripUpdate("t2")), inAMinute());
    await store.replace(feed(tripUpdate("t2", 300)), inAMinute());

    const snapshot = await store.getTripUpdates([
      "2026-12-02/t1",
      "2026-12-02/t2",
    ]);

    expect(snapshot?.tripUpdates).toEqual(
      new Map([["2026-12-02/t2", tripUpdate("t2", 300)]]),
    );
  });

  it("never shows a reader half of a snapshot", async () => {
    // A second connection, so reads land between the writer's commands
    const writer = client.duplicate();
    await writer.connect();
    const writerStore = new RedisTripUpdateStore(writer as RedisClientType);
    const many = (prefix: string) =>
      feed(
        ...Array.from({ length: 500 }, (_, i) => tripUpdate(`${prefix}${i}`)),
      );
    const [a, b] = [many("a"), many("b")];
    const keys = ["a0", "a499", "b0", "b499"].map((id) => `2026-12-02/${id}`);

    let writing = true;
    const writes = (async () => {
      for (let i = 0; i < 40; i++) {
        await writerStore.replace(i % 2 ? a : b, inAMinute());
      }
      writing = false;
    })();
    const seen = new Set<string>();
    while (writing) {
      const snapshot = await store.getTripUpdates(keys);
      seen.add([...(snapshot?.tripUpdates.keys() ?? [])].join());
    }
    await writes;
    await writer.close();

    seen.delete("");
    expect([...seen].sort()).toEqual([
      "2026-12-02/a0,2026-12-02/a499",
      "2026-12-02/b0,2026-12-02/b499",
    ]);
  });

  it("expires the snapshot at the given time", async () => {
    await store.replace(feed(tripUpdate("t1")), new Date(Date.now() + 100));
    expect(await store.getTripUpdates(["2026-12-02/t1"])).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await store.getTripUpdates(["2026-12-02/t1"])).toBeNull();
    expect(await client.exists("realtime:trip-updates")).toBe(0);
  });

  it("lets one caller claim a refresh per cooldown", async () => {
    const claims = await Promise.all(
      Array.from({ length: 10 }, () => store.claimRefresh(100)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await store.claimRefresh(100)).toBe(true);
  });
});
