import type { Departure } from "@tfi-gtfs/tfi-gtfs-core";
import type { ListMode, Trip } from "./protocol";
import type { RouteStopPair } from "./route-stop-pairs";

/** The Departures read for one pair, before its route filter */
export type PairDepartures = {
  pair: RouteStopPair;
  departures: Departure[];
};

/**
 * The trips to show: every pair's Departures on its route, merged, soonest
 * first. `nextPerRoute` keeps the first per Stop, Route and direction (one row
 * each, unlike upstream, which merges the same Route at two Stops). Then the
 * first `limit`.
 */
export function selectTrips(
  results: PairDepartures[],
  { listMode, limit }: { listMode: ListMode; limit: number },
): Trip[] {
  const seenDepartures = new Set<string>();
  const departures = results
    .flatMap(({ pair, departures }) =>
      pair.routeId === null
        ? departures
        : departures.filter((departure) => departure.routeId === pair.routeId),
    )
    .sort(
      (a, b) => departsAt(a) - departsAt(b) || a.tripId.localeCompare(b.tripId),
    )
    .filter((departure) => {
      // The same Departure, read for two pairs at one Stop. The Service Day
      // tells apart today's and tomorrow's runs of a daily Trip
      const key = [departure.tripId, departure.stopId, departure.serviceDate];
      return addIfNew(seenDepartures, key);
    });

  const seenRows = new Set<string>();
  const rows =
    listMode === "nextPerRoute"
      ? departures.filter((departure) =>
          addIfNew(seenRows, [
            departure.stopId,
            departure.routeId,
            String(departure.directionId),
          ]),
        )
      : departures;

  return rows.slice(0, limit).map(toTrip);
}

export function toTrip(departure: Departure): Trip {
  const departureTime = Math.round(departsAt(departure) / 1000);
  return {
    tripId: departure.tripId,
    stopId: departure.stopId,
    routeId: departure.routeId,
    routeName:
      departure.routeShortName ?? departure.routeLongName ?? departure.routeId,
    routeColor: departure.routeColor || null,
    headsign: departure.headsign ?? "",
    stopName: departure.stopName,
    arrivalTime: departureTime,
    departureTime,
    isRealtime: departure.predictedDeparture !== null,
    vehicle: null,
  };
}

function departsAt(departure: Departure): number {
  return (
    departure.predictedDeparture ?? departure.scheduledDeparture
  ).getTime();
}

function addIfNew(seen: Set<string>, key: string[]): boolean {
  const joined = JSON.stringify(key);
  if (seen.has(joined)) return false;
  seen.add(joined);
  return true;
}
