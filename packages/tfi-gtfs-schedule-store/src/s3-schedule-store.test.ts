import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { SchedulePointer } from "@tfi-gtfs/tfi-gtfs-core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { S3ScheduleStore } from "./s3-schedule-store";

const s3 = mockClient(S3Client);
const store = new S3ScheduleStore(
  new S3Client({
    region: "auto",
    credentials: { accessKeyId: "a", secretAccessKey: "b" },
  }),
  "schedule-bucket",
);

// The SDK's Body is a Readable in Node
const streamOf = (text: string) => Readable.from([Buffer.from(text)]) as never;

const pointer: SchedulePointer = {
  key: "schedule/v1/fv1.sqlite.gz",
  feedVersion: "fv1",
  etag: '"zip"',
  sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
  importedAt: "2026-10-15T03:00:00.000Z",
};

describe("S3ScheduleStore", () => {
  beforeEach(() => {
    s3.reset();
  });

  it("reads the pointer for a schema version", async () => {
    s3.on(GetObjectCommand, {
      Bucket: "schedule-bucket",
      Key: "schedule/v1/latest.json",
    }).resolves({ Body: streamOf(JSON.stringify(pointer)) });

    expect(await store.getPointer(1)).toEqual(pointer);
  });

  it("has no pointer when latest.json doesn't exist", async () => {
    s3.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: "missing", $metadata: {} }),
    );

    expect(await store.getPointer(1)).toBeNull();
  });

  it("rejects a malformed pointer", async () => {
    s3.on(GetObjectCommand).resolves({ Body: streamOf('{"key":"x"}') });

    await expect(store.getPointer(1)).rejects.toThrow();
  });

  it("streams an object", async () => {
    s3.on(GetObjectCommand, { Key: "schedule/v1/fv1.sqlite.gz" }).resolves({
      Body: streamOf("hello world"),
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of await store.getObject(
      "schedule/v1/fv1.sqlite.gz",
    )) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString()).toBe("hello world");
  });

  it("uploads a stream and returns its ETag", async () => {
    s3.on(PutObjectCommand).resolves({ ETag: '"abc"' });
    async function* body() {
      yield Buffer.from("hello ");
      yield Buffer.from("world");
    }

    expect(await store.put("schedule/v1/fv1.sqlite.gz", body())).toEqual({
      etag: '"abc"',
    });
    const [put] = s3.commandCalls(PutObjectCommand);
    expect(put?.args[0].input).toMatchObject({
      Bucket: "schedule-bucket",
      Key: "schedule/v1/fv1.sqlite.gz",
      ContentType: "application/gzip",
    });
  });

  it("uploads the pointer as JSON", async () => {
    s3.on(PutObjectCommand).resolves({ ETag: '"abc"' });

    await store.put("schedule/v1/latest.json", JSON.stringify(pointer));

    const [put] = s3.commandCalls(PutObjectCommand);
    expect(put?.args[0].input).toMatchObject({
      Key: "schedule/v1/latest.json",
      ContentType: "application/json",
    });
  });

  it("lists every page under a prefix", async () => {
    s3.on(ListObjectsV2Command, { ContinuationToken: undefined })
      .resolves({
        Contents: [
          { Key: "schedule/v1/a.sqlite.gz", LastModified: new Date(1) },
        ],
        IsTruncated: true,
        NextContinuationToken: "page-2",
      })
      .on(ListObjectsV2Command, { ContinuationToken: "page-2" })
      .resolves({
        Contents: [
          { Key: "schedule/v1/b.sqlite.gz", LastModified: new Date(2) },
        ],
        IsTruncated: false,
      });

    expect(await store.list("schedule/v1/")).toEqual([
      { key: "schedule/v1/a.sqlite.gz", lastModified: new Date(1) },
      { key: "schedule/v1/b.sqlite.gz", lastModified: new Date(2) },
    ]);
    expect(
      s3.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input),
    ).toEqual([
      { Bucket: "schedule-bucket", Prefix: "schedule/v1/" },
      {
        Bucket: "schedule-bucket",
        Prefix: "schedule/v1/",
        ContinuationToken: "page-2",
      },
    ]);
  });

  it("deletes each key", async () => {
    s3.on(DeleteObjectCommand).resolves({});

    await store.delete(["schedule/v1/a.sqlite.gz", "schedule/v1/b.sqlite.gz"]);

    expect(
      s3.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input),
    ).toEqual([
      { Bucket: "schedule-bucket", Key: "schedule/v1/a.sqlite.gz" },
      { Bucket: "schedule-bucket", Key: "schedule/v1/b.sqlite.gz" },
    ]);
  });
});
