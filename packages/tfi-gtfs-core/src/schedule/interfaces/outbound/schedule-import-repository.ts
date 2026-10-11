import type {
  ScheduleImport,
  ScheduleTableName,
  ScheduleTables,
} from "../../domain/types";

export interface ScheduleImportRepository {
  findLatestImport(): Promise<ScheduleImport | null>;
  /**
   * Starts an empty staging copy of the Schedule. Throws if another import
   * holds it.
   */
  createStaging(): Promise<ScheduleStaging>;
}

/** A Schedule being loaded; invisible to readers until published */
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
  /** Replaces the active Schedule with this one and records the import */
  publish(scheduleImport: ScheduleImport): Promise<void>;
  /** Throws away the staging copy */
  discard(): Promise<void>;
}
