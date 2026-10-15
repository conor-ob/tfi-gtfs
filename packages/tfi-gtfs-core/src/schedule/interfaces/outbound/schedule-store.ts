import type {
  ScheduleObjectBody,
  SchedulePointer,
  ScheduleStoreObject,
} from "../../domain/schedule-store";

/**
 * Where the Schedule's SQLite files are published and read: a Railway bucket
 * in production, a local folder with the same key layout otherwise (see
 * docs/adr/0011-full-schedule-served-from-sqlite-file-in-bucket.md).
 */
export interface ScheduleStore {
  /** The pointer for a schema version, or null when none has been published */
  getPointer(schemaVersion: number): Promise<SchedulePointer | null>;
  /** The object's bytes, as a stream. Throws when there is no such object */
  getObject(key: string): Promise<AsyncIterable<Uint8Array>>;
  /**
   * Writes the whole object, replacing any at that key. Readers see the old
   * object or the new one, never part of it. Resolves to the object's ETag
   * (its sha256 in a folder)
   */
  put(key: string, body: ScheduleObjectBody): Promise<{ etag: string }>;
  /** Every object whose key starts with `prefix` */
  list(prefix: string): Promise<ScheduleStoreObject[]>;
  /** Deletes the objects; a missing key is not an error */
  delete(keys: readonly string[]): Promise<void>;
}
