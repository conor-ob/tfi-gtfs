import type { Departure, DepartureQuery } from "../../domain/types";

export interface DepartureService {
  /**
   * The next Departures from a Stop, earliest first. Throws
   * `StopNotFoundError` when the Schedule has no such Stop.
   */
  getDepartures(query: DepartureQuery): Promise<Departure[]>;
}
