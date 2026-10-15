import type {
  DepartureRepository,
  ScheduledStopTime,
  Stop,
} from "@tfi-gtfs/tfi-gtfs-core";
import type { ScheduleDatabase } from "../schedule-database";

// Indexed by Date.getUTCDay()
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

type Weekday = (typeof WEEKDAYS)[number];

type StopRow = Stop;
type StopTimeRow = ScheduledStopTime;

const STOP_COLUMNS = `stop_id AS stopId, stop_code AS stopCode,
  stop_name AS stopName, stop_desc AS stopDesc, stop_lat AS stopLat,
  stop_lon AS stopLon, zone_id AS zoneId, stop_url AS stopUrl,
  location_type AS locationType, parent_station AS parentStation,
  wheelchair_boarding AS wheelchairBoarding`;

const FIND_STOP = `SELECT ${STOP_COLUMNS} FROM stops WHERE stop_id = ?`;

/**
 * Stop Times of Trips that run on the Service Day: a regular weekday in range
 * that wasn't removed (exception_type 2), or an added date (exception_type 1).
 * Stop Times with no pickup (pickup_type 1) aren't Departures. One statement
 * per weekday, since the weekday picks a column
 */
const findStopTimes = (weekday: Weekday) => `
  SELECT t.trip_id AS tripId, s.stop_id AS stopId,
    st.stop_sequence AS stopSequence, st.departure_time AS departureTime,
    coalesce(st.stop_headsign, t.trip_headsign) AS headsign,
    t.direction_id AS directionId, r.route_id AS routeId,
    r.route_short_name AS routeShortName, r.route_long_name AS routeLongName,
    r.route_color AS routeColor, r.route_text_color AS routeTextColor,
    r.route_type AS routeType, r.agency_id AS agencyId
  FROM stops s
  JOIN stop_times st ON st.stop = s.id
  JOIN trips t ON t.id = st.trip
  JOIN routes r ON r.id = t.route
  WHERE s.stop_id = :stopId
    AND st.departure_time BETWEEN :fromTime AND :toTime
    AND (:directionId IS NULL OR t.direction_id = :directionId)
    AND (st.pickup_type IS NULL OR st.pickup_type <> 1)
    AND ((EXISTS (SELECT 1 FROM calendar c WHERE c.service = t.service
            AND c.${weekday} = 1
            AND :serviceDate BETWEEN c.start_date AND c.end_date)
          AND NOT EXISTS (SELECT 1 FROM calendar_dates cd
            WHERE cd.service = t.service AND cd.date = :serviceDate
            AND cd.exception_type = 2))
      OR EXISTS (SELECT 1 FROM calendar_dates cd
            WHERE cd.service = t.service AND cd.date = :serviceDate
            AND cd.exception_type = 1))
  ORDER BY st.departure_time, t.trip_id
  LIMIT :limit`;

export class SqliteDepartureRepository implements DepartureRepository {
  constructor(private readonly schedule: ScheduleDatabase) {
    this.schedule = schedule;
  }

  async findStop(stopId: string): Promise<Stop | null> {
    const row = this.schedule.prepare(FIND_STOP).get(stopId) as
      | StopRow
      | undefined;
    return row ?? null;
  }

  async findScheduledStopTimes({
    stopId,
    serviceDate,
    directionId,
    fromTime,
    toTime,
    limit,
  }: {
    stopId: string;
    serviceDate: string;
    directionId?: number;
    fromTime: number;
    toTime: number;
    limit: number;
  }): Promise<ScheduledStopTime[]> {
    const weekday = WEEKDAYS[new Date(serviceDate).getUTCDay()] ?? "sunday";
    return this.schedule.prepare(findStopTimes(weekday)).all({
      stopId,
      serviceDate,
      directionId: directionId ?? null,
      fromTime,
      toTime,
      limit,
    }) as StopTimeRow[];
  }
}
