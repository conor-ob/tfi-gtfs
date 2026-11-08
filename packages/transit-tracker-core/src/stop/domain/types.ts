import type { Stop } from "../../schedule/domain/types";

/** A Stop within reach of a point */
export type NearbyStop = Stop & {
  /** Straight-line distance from the point, in metres */
  distance: number;
};

export type NearbyStopsQuery = {
  lat: number;
  lon: number;
  /** How far from the point to look, in metres */
  radius: number;
  limit: number;
};
