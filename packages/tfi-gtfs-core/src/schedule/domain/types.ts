// One record per row of a Schedule entry. Field names follow the GTFS columns
// so adapters can map them mechanically. Dates are ISO `YYYY-MM-DD` strings;
// times are seconds since the start of the Service Day.

export type Agency = {
  agencyId: string;
  agencyName: string;
  agencyUrl: string;
  agencyTimezone: string;
};

export type Route = {
  routeId: string;
  agencyId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  routeDesc: string | null;
  routeType: number;
  routeUrl: string | null;
  routeColor: string | null;
  routeTextColor: string | null;
};

export type Trip = {
  tripId: string;
  routeId: string;
  serviceId: string;
  tripHeadsign: string | null;
  tripShortName: string | null;
  directionId: number | null;
  blockId: string | null;
  shapeId: string | null;
};

export type Stop = {
  stopId: string;
  stopCode: string | null;
  stopName: string;
  stopDesc: string | null;
  stopLat: number;
  stopLon: number;
  zoneId: string | null;
  stopUrl: string | null;
  locationType: number | null;
  parentStation: string | null;
  wheelchairBoarding: number | null;
};

/** The regular weekdays of a Service Calendar */
export type ServiceCalendar = {
  serviceId: string;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  startDate: string;
  endDate: string;
};

/** A date added to (1) or removed from (2) a Service Calendar */
export type ServiceCalendarDate = {
  serviceId: string;
  date: string;
  exceptionType: number;
};

export type StopTime = {
  tripId: string;
  arrivalTime: number | null;
  departureTime: number | null;
  stopId: string;
  stopSequence: number;
  stopHeadsign: string | null;
  pickupType: number | null;
  dropOffType: number | null;
  timepoint: number | null;
};

export type FeedInfo = {
  feedVersion: string;
  feedPublisherName: string;
  feedPublisherUrl: string;
  feedLang: string;
  feedStartDate: string | null;
  feedEndDate: string | null;
  feedContactEmail: string | null;
};

/** Schedule entries we import, keyed by GTFS file name without `.txt` */
export type ScheduleTables = {
  agency: Agency;
  routes: Route;
  trips: Trip;
  stops: Stop;
  calendar: ServiceCalendar;
  calendar_dates: ServiceCalendarDate;
  stop_times: StopTime;
  feed_info: FeedInfo;
};

export type ScheduleTableName = keyof ScheduleTables;

/**
 * A successful Schedule Import, used to skip unchanged feeds. The Watched
 * Stops it kept are sorted, or null when it kept every Stop.
 */
export type ScheduleImport = {
  feedVersion: string;
  etag: string | null;
  watchedStopIds: string[] | null;
};

export type ScheduleImportResult =
  | { status: "skipped"; feedVersion: string }
  | {
      status: "imported";
      feedVersion: string;
      rowCounts: Record<ScheduleTableName, number>;
      /** Watched Stops that aren't in the Schedule, e.g. a typo or a retired Stop */
      unknownWatchedStopIds: string[];
    };
