import { DepartureServiceImpl } from "../departure/departure-service";
import type { DepartureService } from "../departure/interfaces/inbound/departure-service";
import type { DepartureRepository } from "../departure/interfaces/outbound/departure-repository";
import type { RealtimeService } from "../realtime/interfaces/inbound/realtime-service";
import type { RealtimeFeedClient } from "../realtime/interfaces/outbound/realtime-feed-client";
import type { TripUpdateStore } from "../realtime/interfaces/outbound/trip-update-store";
import {
  type RealtimeOptions,
  RealtimeServiceImpl,
} from "../realtime/realtime-service";
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
  realtimeFeedClient: RealtimeFeedClient,
  tripUpdateStore: TripUpdateStore,
  realtimeOptions?: Partial<RealtimeOptions>,
): {
  departureService: DepartureService;
  stopService: StopService;
  realtimeService: RealtimeService;
} {
  const realtimeService = new RealtimeServiceImpl(
    realtimeFeedClient,
    tripUpdateStore,
    realtimeOptions,
  );
  return {
    departureService: new DepartureServiceImpl(
      departureRepository,
      realtimeService,
    ),
    stopService: new StopServiceImpl(stopRepository),
    realtimeService,
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
