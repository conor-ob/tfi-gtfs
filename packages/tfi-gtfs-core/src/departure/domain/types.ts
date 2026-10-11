/** A Stop Time joined to its Trip and Route, before it is placed on a Service Day */
export type ScheduledStopTime = {
  tripId: string;
  stopId: string;
  stopSequence: number;
  /** Seconds since the start of the Service Day */
  departureTime: number;
  /** The Stop Time's headsign, falling back to the Trip's */
  headsign: string | null;
  directionId: number | null;
  routeId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  routeType: number;
  agencyId: string;
};

/** A Trip leaving a Stop on one Service Day */
export type Departure = Omit<ScheduledStopTime, "departureTime"> & {
  /**
   * The Service Day the Trip belongs to, as `YYYY-MM-DD`. With `tripId` it
   * matches the Trip Update's `start_date`.
   */
  serviceDate: string;
  scheduledDeparture: Date;
};

export type DepartureQuery = {
  stopId: string;
  /** Earliest Scheduled Departure to include; defaults to now */
  from?: Date;
  limit: number;
};
