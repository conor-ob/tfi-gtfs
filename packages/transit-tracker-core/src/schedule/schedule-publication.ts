import { createHash } from "node:crypto";
import {
  SCHEDULE_OBJECT_SUFFIX,
  type SchedulePointer,
  scheduleKeyPrefix,
  scheduleObjectKey,
  schedulePointerKey,
} from "./domain/schedule-store";
import type { ScheduleStore } from "./interfaces/outbound/schedule-store";

/** Schedule files kept per schema version, so a rollback has somewhere to go */
export const SCHEDULE_FILES_KEPT = 7;

export class ScheduleHashMismatchError extends Error {
  constructor(key: string, expected: string, actual: string) {
    super(`${key} has sha256 ${actual}, but the pointer expects ${expected}`);
    this.name = "ScheduleHashMismatchError";
  }
}

export type PublishScheduleInput = {
  schemaVersion: number;
  feedVersion: string;
  /** The Schedule zip's ETag */
  etag: string | null;
  /** The gzipped SQLite file */
  body: AsyncIterable<Uint8Array>;
  now?: () => Date;
};

/**
 * Uploads the file, then points `latest.json` at it, then deletes all but the
 * newest `SCHEDULE_FILES_KEPT` files of that schema version. Readers only
 * ever follow the pointer, so they never see a half-uploaded file, and a
 * failed upload leaves the pointer where it was.
 */
export async function publishSchedule(
  store: ScheduleStore,
  {
    schemaVersion,
    feedVersion,
    etag,
    body,
    now = () => new Date(),
  }: PublishScheduleInput,
): Promise<SchedulePointer> {
  const key = scheduleObjectKey(schemaVersion, feedVersion);
  const hash = createHash("sha256");
  await store.put(
    key,
    tap(body, (chunk) => hash.update(chunk)),
  );

  const pointer: SchedulePointer = {
    key,
    feedVersion,
    etag,
    sha256: hash.digest("hex"),
    importedAt: now().toISOString(),
  };
  await store.put(
    schedulePointerKey(schemaVersion),
    JSON.stringify(pointer, null, 2),
  );

  await pruneSchedules(store, schemaVersion, key);
  return pointer;
}

/** Deletes all but the newest files of one schema version, never `keep` */
async function pruneSchedules(
  store: ScheduleStore,
  schemaVersion: number,
  keep: string,
) {
  const files = (await store.list(scheduleKeyPrefix(schemaVersion)))
    .filter(({ key }) => key.endsWith(SCHEDULE_OBJECT_SUFFIX))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  const kept = new Set([keep]);
  for (const { key } of files) {
    if (kept.size >= SCHEDULE_FILES_KEPT) break;
    kept.add(key);
  }
  const stale = files.map(({ key }) => key).filter((key) => !kept.has(key));
  if (stale.length > 0) await store.delete(stale);
}

export type FetchedSchedule = {
  pointer: SchedulePointer;
  /**
   * The file's bytes. Throws `ScheduleHashMismatchError` once the stream ends
   * if they don't match the pointer, so only use the file once it has been
   * read through
   */
  body: AsyncIterable<Uint8Array>;
};

/**
 * The file `latest.json` points at for a schema version, or null when none
 * has been published
 */
export async function fetchSchedule(
  store: ScheduleStore,
  schemaVersion: number,
): Promise<FetchedSchedule | null> {
  const pointer = await store.getPointer(schemaVersion);
  if (!pointer) return null;
  const object = await store.getObject(pointer.key);
  return { pointer, body: verifySha256(object, pointer) };
}

async function* verifySha256(
  chunks: AsyncIterable<Uint8Array>,
  { key, sha256 }: SchedulePointer,
): AsyncIterable<Uint8Array> {
  const hash = createHash("sha256");
  yield* tap(chunks, (chunk) => hash.update(chunk));
  const actual = hash.digest("hex");
  if (actual !== sha256) {
    throw new ScheduleHashMismatchError(key, sha256, actual);
  }
}

async function* tap<T>(
  items: AsyncIterable<T>,
  see: (item: T) => void,
): AsyncIterable<T> {
  for await (const item of items) {
    see(item);
    yield item;
  }
}
