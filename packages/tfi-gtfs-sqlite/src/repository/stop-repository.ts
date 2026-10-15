import type {
  NearbyStop,
  NearbyStopsQuery,
  StopRepository,
} from "@tfi-gtfs/tfi-gtfs-core";
import type { ScheduleDatabase } from "../schedule-database";

// Mean Earth radius
const EARTH_RADIUS_METRES = 6_371_008.8;
const METRES_PER_DEGREE_LAT = (Math.PI * EARTH_RADIUS_METRES) / 180;

type NearbyStopRow = NearbyStop;

// A box around the circle narrows the search on the stop_lat, stop_lon index;
// the haversine distance then trims its corners. Only Stops you can board at
// (location_type 0 or empty)
const FIND_STOPS_NEAR = `
  SELECT * FROM (
    SELECT stop_id AS stopId, stop_code AS stopCode, stop_name AS stopName,
      stop_desc AS stopDesc, stop_lat AS stopLat, stop_lon AS stopLon,
      zone_id AS zoneId, stop_url AS stopUrl, location_type AS locationType,
      parent_station AS parentStation,
      wheelchair_boarding AS wheelchairBoarding,
      2 * ${EARTH_RADIUS_METRES} * asin(min(1, sqrt(
        pow(sin(radians(stop_lat - :lat) / 2), 2)
        + cos(radians(:lat)) * cos(radians(stop_lat))
        * pow(sin(radians(stop_lon - :lon) / 2), 2)))) AS distance
    FROM stops
    WHERE stop_lat BETWEEN :minLat AND :maxLat
      AND stop_lon BETWEEN :minLon AND :maxLon
      AND (location_type IS NULL OR location_type = 0)
  )
  WHERE distance <= :radius
  ORDER BY distance, stopId
  LIMIT :limit`;

export class SqliteStopRepository implements StopRepository {
  constructor(private readonly schedule: ScheduleDatabase) {
    this.schedule = schedule;
  }

  async findStopsNear({
    lat,
    lon,
    radius,
    limit,
  }: NearbyStopsQuery): Promise<NearbyStop[]> {
    const latDelta = radius / METRES_PER_DEGREE_LAT;
    const lonDelta =
      radius / (METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
    return this.schedule.prepare(FIND_STOPS_NEAR).all({
      lat,
      lon,
      radius,
      minLat: lat - latDelta,
      maxLat: lat + latDelta,
      minLon: lon - lonDelta,
      maxLon: lon + lonDelta,
      limit,
    }) as NearbyStopRow[];
  }
}
