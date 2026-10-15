import { z } from "zod";

/**
 * `latest.json`: the Feed Version a schema version's readers should load.
 * Writing it is the publish step (see
 * docs/adr/0011-full-schedule-served-from-sqlite-file-in-bucket.md).
 */
export const schedulePointerSchema = z.object({
  /** The object's key, e.g. `schedule/v1/<feedVersion>.sqlite.gz` */
  key: z.string().min(1),
  feedVersion: z.string().min(1),
  /** The Schedule zip's ETag, which with `feedVersion` skips unchanged feeds */
  etag: z.string().nullable(),
  /** Hex sha256 of the object's bytes, checked on every read */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** ISO 8601 */
  importedAt: z.iso.datetime(),
});

export type SchedulePointer = z.infer<typeof schedulePointerSchema>;

export function parseSchedulePointer(json: string): SchedulePointer {
  return schedulePointerSchema.parse(JSON.parse(json));
}

export type ScheduleObjectBody = AsyncIterable<Uint8Array> | string;

export type ScheduleStoreObject = {
  key: string;
  lastModified: Date;
};

/** Every key for one schema version starts with this */
export function scheduleKeyPrefix(schemaVersion: number): string {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`Invalid schema version: ${schemaVersion}`);
  }
  return `schedule/v${schemaVersion}/`;
}

export function schedulePointerKey(schemaVersion: number): string {
  return `${scheduleKeyPrefix(schemaVersion)}latest.json`;
}

export function scheduleObjectKey(
  schemaVersion: number,
  feedVersion: string,
): string {
  if (/^\.*$|[/\\]/.test(feedVersion)) {
    throw new Error(`Feed Version can't be used in a key: ${feedVersion}`);
  }
  return `${scheduleKeyPrefix(schemaVersion)}${feedVersion}${SCHEDULE_OBJECT_SUFFIX}`;
}

export const SCHEDULE_OBJECT_SUFFIX = ".sqlite.gz";
