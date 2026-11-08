import type { Stop } from "../../../schedule/domain/types";
import type { ScheduledStopTime } from "../../domain/types";

export interface DepartureRepository {
  findStop(stopId: string): Promise<Stop | null>;
  /**
   * Stop Times at a Stop whose Trip runs on the Service Day, departing between
   * `fromTime` and `toTime` (inclusive, seconds since the start of the Service
   * Day), earliest first. Leaves out Stop Times with no pickup, such as the
   * last Stop of a Trip. With `directionId`, only Trips in that direction.
   */
  findScheduledStopTimes(query: {
    stopId: string;
    serviceDate: string;
    directionId?: number;
    fromTime: number;
    toTime: number;
    limit: number;
  }): Promise<ScheduledStopTime[]>;
}
