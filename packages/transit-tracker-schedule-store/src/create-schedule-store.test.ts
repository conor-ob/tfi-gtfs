import { describe, expect, it } from "vitest";
import { createScheduleStore } from "./create-schedule-store";
import { FsScheduleStore } from "./fs-schedule-store";
import { S3ScheduleStore } from "./s3-schedule-store";

const bucket = {
  SCHEDULE_STORE: "s3",
  SCHEDULE_BUCKET_ENDPOINT: "https://t3.storage.dev",
  SCHEDULE_BUCKET_REGION: "auto",
  SCHEDULE_BUCKET_NAME: "schedule-abc",
  SCHEDULE_BUCKET_ACCESS_KEY_ID: "id",
  SCHEDULE_BUCKET_SECRET_ACCESS_KEY: "secret",
};

describe("createScheduleStore", () => {
  it("uses a folder by default", () => {
    expect(createScheduleStore({})).toBeInstanceOf(FsScheduleStore);
  });

  it("uses the bucket with SCHEDULE_STORE=s3", () => {
    expect(createScheduleStore(bucket)).toBeInstanceOf(S3ScheduleStore);
  });

  it.each(Object.keys(bucket).filter((name) => name !== "SCHEDULE_STORE"))(
    "names %s when it's missing",
    (name) => {
      expect(() =>
        createScheduleStore({ ...bucket, [name]: undefined }),
      ).toThrow(`${name} is required when SCHEDULE_STORE is s3`);
    },
  );

  it("treats an empty variable as missing", () => {
    expect(() =>
      createScheduleStore({ ...bucket, SCHEDULE_BUCKET_NAME: "" }),
    ).toThrow("SCHEDULE_BUCKET_NAME is required");
  });

  it("rejects an unknown store", () => {
    expect(() => createScheduleStore({ SCHEDULE_STORE: "gcs" })).toThrow(
      "SCHEDULE_STORE",
    );
  });
});
