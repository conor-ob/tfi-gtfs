import { useQueries } from "@tanstack/react-query";

import { departsAt } from "./departure-row";
import { REFETCH_INTERVAL_MS, STOPS } from "./stops";
import { trpc } from "./trpc";

/**
 * Every Stop's upcoming Departures as one list, soonest first, and per Stop.
 * With `walkTime`, only the catchable ones, like the Departure Board: a
 * Departure goes once it leaves sooner than its Stop's Walk Time
 */
export function useStopDepartures({
  now,
  limit,
  walkTime,
}: {
  now: Date;
  limit: number;
  walkTime: boolean;
}) {
  const results = useQueries({
    queries: STOPS.map(({ stopId, directionId, walkTimeSeconds }) => ({
      ...trpc.departures.getByStop.queryOptions({
        stopId,
        directionId,
        walkTimeSeconds: walkTime ? walkTimeSeconds : undefined,
        limit,
      }),
      refetchInterval: REFETCH_INTERVAL_MS,
    })),
  });

  // The server leaves out Departures within the Walk Time (or gone) when it
  // reads them; filtering again drops those that go between refetches
  const stops = STOPS.map((stop, index) => {
    const result = results[index];
    return {
      stop,
      departures: (result?.data ?? []).filter(
        (departure) =>
          departsAt(departure).getTime() >=
          now.getTime() + (walkTime ? stop.walkTimeSeconds * 1000 : 0),
      ),
      error: result?.error ?? null,
      loading: result?.isPending ?? true,
    };
  });
  const departures = stops
    .flatMap((stop) => stop.departures)
    .sort((a, b) => departsAt(a).getTime() - departsAt(b).getTime())
    .slice(0, limit);

  const errors = STOPS.flatMap((stop, index) => {
    const error = results[index]?.error;
    return error ? [{ stop, error }] : [];
  });

  return {
    departures,
    /** Each Stop's own Departures, up to `limit` */
    stops,
    errors,
    loading: results.some((result) => result.isPending),
    // The oldest read, so "updated" never hides a Stop that has stopped updating
    updatedAt: Math.min(...results.map((result) => result.dataUpdatedAt)),
  };
}
