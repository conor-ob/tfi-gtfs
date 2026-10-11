/** The latest prediction for one Trip's upcoming Stop */
export type StopTimeUpdate = {
  stopSequence: number;
  stopId: string;
  /** The Trip no longer stops here */
  skipped: boolean;
  /** Seconds behind (positive) or ahead of (negative) the Stop Time */
  delay: number | null;
};

/** The latest live prediction for one Trip on one Service Day */
export type TripUpdate = {
  tripId: string;
  /** The Trip's Service Day, as `YYYY-MM-DD` */
  startDate: string;
  canceled: boolean;
  /** The Trip's current Delay, for Stops no Stop Time Update covers */
  delay: number | null;
  /** Ordered by `stopSequence` */
  stopTimeUpdates: StopTimeUpdate[];
};

/** Every Trip Update in one read of the Realtime Feed */
export type TripUpdateFeed = {
  /** When the publisher produced this data */
  timestamp: Date;
  tripUpdates: TripUpdate[];
};

/** A Realtime Feed read, indexed for matching Departures */
export type TripUpdateSnapshot = {
  timestamp: Date;
  /** Keyed by `tripUpdateKey` */
  tripUpdates: ReadonlyMap<string, TripUpdate>;
};

export function tripUpdateKey(tripId: string, startDate: string): string {
  return `${startDate}/${tripId}`;
}
