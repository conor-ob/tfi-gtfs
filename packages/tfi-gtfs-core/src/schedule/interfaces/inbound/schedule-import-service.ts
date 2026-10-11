import type { ScheduleImportResult } from "../../domain/types";

export interface ScheduleImportService {
  /**
   * Replaces the active Schedule with the published Feed Version, all at once
   * or not at all. Skips the import when the feed is unchanged.
   */
  importSchedule(): Promise<ScheduleImportResult>;
}
