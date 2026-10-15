import type {
  ScheduleImport,
  ScheduleTableName,
  ScheduleTables,
} from "../../domain/types";

/** Builds the Schedule as one file, to be published to the `ScheduleStore` */
export interface ScheduleImportRepository {
  /** The layout of the files it builds, part of each file's key */
  readonly schemaVersion: number;
  /**
   * Starts an empty staging copy of the Schedule. Throws if another import
   * holds it.
   */
  createStaging(): Promise<ScheduleStaging>;
}

/** A Schedule being loaded */
export interface ScheduleStaging {
  /** Appends rows to one table and returns how many were written */
  load<T extends ScheduleTableName>(
    table: T,
    rows: AsyncIterable<ScheduleTables[T]>,
  ): Promise<number>;
  /**
   * Adds keys and indexes, then returns a description of each integrity
   * problem found. Throws if keys cannot be added (e.g. duplicate rows).
   */
  check(): Promise<string[]>;
  /** Finishes the file, recording the import in it, and hands it back */
  build(scheduleImport: ScheduleImport): Promise<BuiltSchedule>;
  /** Throws away the staging copy */
  discard(): Promise<void>;
}

/** A whole, checked Schedule file */
export interface BuiltSchedule {
  sizeBytes: number;
  /** The file's bytes, uncompressed; each call reads it afresh */
  read(): AsyncIterable<Uint8Array>;
}
