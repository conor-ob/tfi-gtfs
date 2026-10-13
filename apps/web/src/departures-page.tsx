import { useQueries } from "@tanstack/react-query";

import { DepartureRow, departsAt, formatAgo, useNow } from "./departure-row";
import { REFETCH_INTERVAL_MS, STOPS } from "./stops";
import { trpc } from "./trpc";

const ROWS = 10;

/** Every Stop's catchable Departures as one list, soonest first */
export function DeparturesPage() {
  const now = useNow();
  const results = useQueries({
    queries: STOPS.map(({ stopId, directionId, walkTimeSeconds }) => ({
      ...trpc.departures.getByStop.queryOptions({
        stopId,
        directionId,
        walkTimeSeconds,
        limit: ROWS,
      }),
      refetchInterval: REFETCH_INTERVAL_MS,
    })),
  });

  // The server leaves out Departures within the Walk Time when it reads them;
  // filtering again drops those that become uncatchable between refetches
  const departures = STOPS.flatMap((stop, index) =>
    (results[index]?.data ?? []).filter(
      (departure) =>
        departsAt(departure).getTime() >=
        now.getTime() + stop.walkTimeSeconds * 1000,
    ),
  )
    .sort((a, b) => departsAt(a).getTime() - departsAt(b).getTime())
    .slice(0, ROWS);

  const loading = results.some((result) => result.isPending);
  // The oldest read, so "updated" never hides a Stop that has stopped updating
  const updatedAt = Math.min(...results.map((result) => result.dataUpdatedAt));

  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <header className="mb-2 flex items-baseline justify-between">
        <h1 className="font-semibold text-lg">Departures</h1>
        {updatedAt > 0 && (
          <span className="text-neutral-500 text-xs">
            updated {formatAgo(now.getTime() - updatedAt)}
          </span>
        )}
      </header>
      {STOPS.map((stop, index) => {
        const error = results[index]?.error;
        return error ? (
          <p key={stop.stopId} className="text-red-600 text-sm">
            {stop.name}: {error.message}
          </p>
        ) : null;
      })}
      {departures.length === 0 ? (
        <p className="text-neutral-500 text-sm">
          {loading ? "Loading…" : "No departures"}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {departures.map((departure) => (
            <DepartureRow
              key={`${departure.tripId}-${departure.stopId}-${departure.serviceDate}`}
              departure={departure}
              now={now}
              showStop
            />
          ))}
        </ul>
      )}
    </main>
  );
}
