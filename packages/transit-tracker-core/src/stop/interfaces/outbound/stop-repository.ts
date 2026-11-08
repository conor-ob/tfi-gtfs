import type { NearbyStop, NearbyStopsQuery } from "../../domain/types";

export interface StopRepository {
  /**
   * Stops within `radius` metres of the point, nearest first. Leaves out
   * Stations and other Stops nobody boards at.
   */
  findStopsNear(query: NearbyStopsQuery): Promise<NearbyStop[]>;
}
