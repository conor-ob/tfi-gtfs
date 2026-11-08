import type { ScheduleImportResult } from "../../domain/types";

export interface ScheduleImportService {
  /**
   * Builds the published Feed Version and makes it the active Schedule, all
   * at once or not at all. Skips the import when the feed is unchanged.
   */
  importSchedule(): Promise<ScheduleImportResult>;
}
