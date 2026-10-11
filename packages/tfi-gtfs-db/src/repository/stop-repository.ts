import type {
  NearbyStop,
  NearbyStopsQuery,
  StopRepository,
} from "@tfi-gtfs/tfi-gtfs-core";
import {
  and,
  asc,
  between,
  eq,
  getTableColumns,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { stopsTable } from "../db/schema";

// Mean Earth radius
const EARTH_RADIUS_METRES = 6_371_008.8;
const METRES_PER_DEGREE_LAT = (Math.PI * EARTH_RADIUS_METRES) / 180;

const BOARDING_POINT = 0;

export class StopRepositoryImpl implements StopRepository {
  constructor(private readonly database: NodePgDatabase) {
    this.database = database;
  }

  async findStopsNear({
    lat,
    lon,
    radius,
    limit,
  }: NearbyStopsQuery): Promise<NearbyStop[]> {
    // A box around the circle narrows the search on the stop_lat, stop_lon
    // index; the haversine distance then trims its corners
    const latDelta = radius / METRES_PER_DEGREE_LAT;
    const lonDelta =
      radius / (METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
    // Typed, or Postgres infers integer parameters from `2 * $1`
    const pointLat = sql`${lat}::float8`;
    const pointLon = sql`${lon}::float8`;
    const distance = sql<number>`2 * ${EARTH_RADIUS_METRES}::float8 * asin(least(1, sqrt(
      power(sin(radians(${stopsTable.stopLat} - ${pointLat}) / 2), 2)
      + cos(radians(${pointLat})) * cos(radians(${stopsTable.stopLat}))
      * power(sin(radians(${stopsTable.stopLon} - ${pointLon}) / 2), 2)
    )))`;

    return this.database
      .select({
        ...getTableColumns(stopsTable),
        distance: distance.as("distance"),
      })
      .from(stopsTable)
      .where(
        and(
          between(stopsTable.stopLat, lat - latDelta, lat + latDelta),
          between(stopsTable.stopLon, lon - lonDelta, lon + lonDelta),
          or(
            isNull(stopsTable.locationType),
            eq(stopsTable.locationType, BOARDING_POINT),
          ),
          lte(distance, radius),
        ),
      )
      .orderBy(sql`distance`, asc(stopsTable.stopId))
      .limit(limit);
  }
}
