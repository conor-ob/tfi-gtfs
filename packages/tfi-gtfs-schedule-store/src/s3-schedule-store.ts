import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  parseSchedulePointer,
  type ScheduleObjectBody,
  type SchedulePointer,
  type ScheduleStore,
  type ScheduleStoreObject,
  schedulePointerKey,
} from "@tfi-gtfs/tfi-gtfs-core";

/**
 * Railway's Tigris-backed bucket (see
 * docs/adr/0011-full-schedule-served-from-sqlite-file-in-bucket.md). Tigris
 * reads its own writes within a region, overwrites included, so a new
 * pointer is seen as soon as it is written.
 */
export class S3ScheduleStore implements ScheduleStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    this.client = client;
    this.bucket = bucket;
  }

  async getPointer(schemaVersion: number): Promise<SchedulePointer | null> {
    try {
      const body = await this.getObject(schedulePointerKey(schemaVersion));
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      return parseSchedulePointer(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async getObject(key: string): Promise<AsyncIterable<Uint8Array>> {
    const { Body } = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!(Body instanceof Readable)) {
      throw new Error(`${key} has no readable body`);
    }
    return Body;
  }

  async put(key: string, body: ScheduleObjectBody): Promise<{ etag: string }> {
    // Upload takes a stream of unknown length, going multipart when it's big
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: typeof body === "string" ? body : Readable.from(body),
        ContentType: key.endsWith(".json")
          ? "application/json"
          : "application/gzip",
      },
    });
    const { ETag } = await upload.done();
    if (!ETag) throw new Error(`Uploading ${key} returned no ETag`);
    return { etag: ETag };
  }

  async list(prefix: string): Promise<ScheduleStoreObject[]> {
    const objects: ScheduleStoreObject[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const { Key, LastModified } of page.Contents ?? []) {
        if (Key && LastModified) {
          objects.push({ key: Key, lastModified: LastModified });
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return objects;
  }

  async delete(keys: readonly string[]): Promise<void> {
    // A handful of keys a day, so one request each keeps errors simple
    for (const key of keys) {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    }
  }
}
