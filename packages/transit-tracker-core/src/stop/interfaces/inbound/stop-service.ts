import type { NearbyStop, NearbyStopsQuery } from "../../domain/types";

export interface StopService {
  /** Stops passengers can board at within the radius, nearest first */
  getNearbyStops(query: NearbyStopsQuery): Promise<NearbyStop[]>;
}
