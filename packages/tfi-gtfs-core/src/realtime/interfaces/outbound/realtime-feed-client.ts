import type { TripUpdateFeed } from "../../domain/types";

export interface RealtimeFeedClient {
  /**
   * Reads every Trip Update for Trips in the Schedule. Leaves out Trips the
   * Schedule doesn't know, such as ADDED Trips.
   */
  fetchTripUpdates(): Promise<TripUpdateFeed>;
}
