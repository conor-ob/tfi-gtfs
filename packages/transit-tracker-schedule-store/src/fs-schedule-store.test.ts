import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsScheduleStore } from "./fs-schedule-store";

describe("FsScheduleStore", () => {
  let root: string;
  let store: FsScheduleStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "schedule-store-"));
    store = new FsScheduleStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses the object's sha256 as its ETag", async () => {
    expect(await store.put("schedule/v1/a.sqlite.gz", "hello world")).toEqual({
      etag: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    });
  });

  it("renames each write into place, leaving no temp file", async () => {
    await store.put("schedule/v1/latest.json", "{}");

    expect(await readdir(path.join(root, "schedule", "v1"))).toEqual([
      "latest.json",
    ]);
  });

  it("lists nothing in a folder that doesn't exist yet", async () => {
    expect(await new FsScheduleStore(path.join(root, "nope")).list("")).toEqual(
      [],
    );
  });

  it("fails to get a missing object", async () => {
    await expect(
      store.getObject("schedule/v1/missing.sqlite.gz"),
    ).rejects.toThrow();
  });

  it("ignores deleting a missing object", async () => {
    await expect(
      store.delete(["schedule/v1/missing.sqlite.gz"]),
    ).resolves.toBeUndefined();
  });

  it("refuses keys outside its folder", async () => {
    await expect(store.put("../escape", "x")).rejects.toThrow(
      "outside the Schedule folder",
    );
  });
});
