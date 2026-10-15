import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fetchSchedule,
  publishSchedule,
  SCHEDULE_FILES_KEPT,
  ScheduleHashMismatchError,
  type ScheduleStore,
  scheduleObjectKey,
  schedulePointerKey,
} from "@tfi-gtfs/tfi-gtfs-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsScheduleStore } from "./fs-schedule-store";

async function* bytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield new TextEncoder().encode(chunk);
}

async function* failingAfter(chunk: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(chunk);
  throw new Error("connection reset");
}

async function text(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const all: Uint8Array[] = [];
  for await (const chunk of chunks) all.push(chunk);
  return Buffer.concat(all).toString("utf8");
}

async function fetched(store: ScheduleStore) {
  const schedule = await fetchSchedule(store, 1);
  if (!schedule) throw new Error("Nothing was published");
  return schedule;
}

const publish = (
  store: ScheduleStore,
  feedVersion: string,
  { schemaVersion = 1, body = bytes(`file ${feedVersion}`) } = {},
) =>
  publishSchedule(store, {
    schemaVersion,
    feedVersion,
    etag: `"etag-${feedVersion}"`,
    body,
    now: () => new Date("2026-10-15T03:00:00Z"),
  });

describe("publishSchedule and fetchSchedule against FsScheduleStore", () => {
  let root: string;
  let store: FsScheduleStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "schedule-store-"));
    store = new FsScheduleStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("has nothing to fetch before anything is published", async () => {
    expect(await fetchSchedule(store, 1)).toBeNull();
  });

  it("publishes the file and points latest.json at it", async () => {
    const pointer = await publish(store, "fv1", {
      body: bytes("hello ", "world"),
    });

    expect(pointer).toEqual({
      key: "schedule/v1/fv1.sqlite.gz",
      feedVersion: "fv1",
      etag: '"etag-fv1"',
      sha256:
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      importedAt: "2026-10-15T03:00:00.000Z",
    });
    expect(await store.getPointer(1)).toEqual(pointer);

    const { pointer: read, body } = await fetched(store);
    expect(read).toEqual(pointer);
    expect(await text(body)).toBe("hello world");
  });

  it("writes the pointer last", async () => {
    const put = vi.spyOn(store, "put");

    await publish(store, "fv1");

    expect(put.mock.calls.map(([key]) => key)).toEqual([
      scheduleObjectKey(1, "fv1"),
      schedulePointerKey(1),
    ]);
  });

  it("leaves the old pointer and no file behind when an upload fails", async () => {
    const old = await publish(store, "fv1");

    await expect(
      publish(store, "fv2", { body: failingAfter("half a file") }),
    ).rejects.toThrow("connection reset");

    expect(await store.getPointer(1)).toEqual(old);
    expect((await store.list("schedule/")).map(({ key }) => key)).toEqual(
      expect.not.arrayContaining([scheduleObjectKey(1, "fv2")]),
    );
  });

  it(`keeps the newest ${SCHEDULE_FILES_KEPT} files`, async () => {
    for (let i = 1; i <= SCHEDULE_FILES_KEPT + 2; i++) {
      await publish(store, `fv${i}`);
      // mtimes a second apart, so the order doesn't hang on clock resolution
      const when = new Date(Date.UTC(2020, 0, 1, 0, 0, i));
      await utimes(
        path.join(root, ...scheduleObjectKey(1, `fv${i}`).split("/")),
        when,
        when,
      );
    }

    const keys = (await store.list("schedule/v1/")).map(({ key }) => key);
    expect(keys.sort()).toEqual(
      [
        schedulePointerKey(1),
        ...[3, 4, 5, 6, 7, 8, 9].map((i) => scheduleObjectKey(1, `fv${i}`)),
      ].sort(),
    );
    expect((await store.getPointer(1))?.feedVersion).toBe("fv9");
  });

  it("keeps the file just published even when older ones look newer", async () => {
    for (let i = 1; i <= SCHEDULE_FILES_KEPT; i++) {
      await publish(store, `fv${i}`);
    }
    const future = new Date(Date.now() + 60_000);
    for (let i = 1; i <= SCHEDULE_FILES_KEPT; i++) {
      await utimes(
        path.join(root, ...scheduleObjectKey(1, `fv${i}`).split("/")),
        future,
        future,
      );
    }

    await publish(store, "fv-new");

    const keys = (await store.list("schedule/v1/")).map(({ key }) => key);
    expect(keys).toContain(scheduleObjectKey(1, "fv-new"));
    expect(keys.filter((key) => key.endsWith(".sqlite.gz"))).toHaveLength(
      SCHEDULE_FILES_KEPT,
    );
  });

  it("prunes one schema version and leaves the others alone", async () => {
    for (let i = 1; i <= SCHEDULE_FILES_KEPT; i++) {
      await publish(store, `old${i}`, { schemaVersion: 1 });
      await publish(store, `old${i}`, { schemaVersion: 10 });
    }

    for (let i = 1; i <= SCHEDULE_FILES_KEPT + 3; i++) {
      await publish(store, `new${i}`, { schemaVersion: 2 });
    }

    const files = async (schemaVersion: number) =>
      (await store.list(`schedule/v${schemaVersion}/`)).filter(({ key }) =>
        key.endsWith(".sqlite.gz"),
      );
    expect(await files(1)).toHaveLength(SCHEDULE_FILES_KEPT);
    expect(await files(10)).toHaveLength(SCHEDULE_FILES_KEPT);
    expect(await files(2)).toHaveLength(SCHEDULE_FILES_KEPT);
    expect((await store.getPointer(1))?.feedVersion).toBe(
      `old${SCHEDULE_FILES_KEPT}`,
    );
  });

  it("rejects a file whose hash doesn't match the pointer", async () => {
    await publish(store, "fv1", { body: bytes("the real file") });
    // Replaced behind the pointer's back
    await store.put(scheduleObjectKey(1, "fv1"), "a corrupted file");

    const { body } = await fetched(store);

    await expect(text(body)).rejects.toThrow(ScheduleHashMismatchError);
  });
});
