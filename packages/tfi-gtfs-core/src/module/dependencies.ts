import { DepartureServiceImpl } from "../departure/departure-service";
import type { DepartureService } from "../departure/interfaces/inbound/departure-service";
import type { DepartureRepository } from "../departure/interfaces/outbound/departure-repository";
import type { ScheduleImportService } from "../schedule/interfaces/inbound/schedule-import-service";
import type { ScheduleFeedClient } from "../schedule/interfaces/outbound/schedule-feed-client";
import type { ScheduleImportRepository } from "../schedule/interfaces/outbound/schedule-import-repository";
import { ScheduleImportServiceImpl } from "../schedule/schedule-import-service";
import type { StopService } from "../stop/interfaces/inbound/stop-service";
import type { StopRepository } from "../stop/interfaces/outbound/stop-repository";
import { StopServiceImpl } from "../stop/stop-service";

// Composition roots for core services. Outbound ports (repositories, feed
// clients) are passed in by the app that wires everything together.
export function injectDependencies(
  departureRepository: DepartureRepository,
  stopRepository: StopRepository,
): {
  departureService: DepartureService;
  stopService: StopService;
} {
  return {
    departureService: new DepartureServiceImpl(departureRepository),
    stopService: new StopServiceImpl(stopRepository),
  };
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
