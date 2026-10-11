import type { ScheduleImportService } from "../schedule/interfaces/inbound/schedule-import-service";
import type { ScheduleFeedClient } from "../schedule/interfaces/outbound/schedule-feed-client";
import type { ScheduleImportRepository } from "../schedule/interfaces/outbound/schedule-import-repository";
import { ScheduleImportServiceImpl } from "../schedule/schedule-import-service";

// Composition roots for core services. Outbound ports (repositories, feed
// clients) are passed in by the app that wires everything together.
export function injectDependencies() {
  return {};
}

// The Schedule Import runs in its own job (see
// docs/adr/0002-schedule-import-job-writes-directly-to-postgres.md)
export function injectScheduleImportDependencies(
  scheduleFeedClient: ScheduleFeedClient,
  scheduleImportRepository: ScheduleImportRepository,
): { scheduleImportService: ScheduleImportService } {
  return {
    scheduleImportService: new ScheduleImportServiceImpl(
      scheduleFeedClient,
      scheduleImportRepository,
    ),
  };
}
