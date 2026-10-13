import { useQuery } from "@tanstack/react-query";

import { DepartureRow, formatAgo, useNow } from "./departure-row";
import { REFETCH_INTERVAL_MS, STOPS } from "./stops";
import { trpc } from "./trpc";

/** A section of upcoming Departures per Stop, from now */
export function StopsPage() {
  const now = useNow();

  return (
    <main className="mx-auto max-w-md space-y-8 px-4 py-6">
      {STOPS.map((stop) => (
        <StopDepartures
          key={stop.stopId}
          stopId={stop.stopId}
          name={stop.name}
          directionId={stop.directionId}
          now={now}
        />
      ))}
    </main>
  );
}

function StopDepartures({
  stopId,
  name,
  directionId,
  now,
}: {
  stopId: string;
  name: string;
  directionId?: 0 | 1;
  now: Date;
}) {
  const { data, error, dataUpdatedAt } = useQuery({
    ...trpc.departures.getByStop.queryOptions({
      stopId,
      directionId,
      limit: 6,
    }),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  return (
    <section>
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="font-semibold text-lg">{name}</h2>
        {dataUpdatedAt > 0 && (
          <span className="text-neutral-500 text-xs">
            updated {formatAgo(now.getTime() - dataUpdatedAt)}
          </span>
        )}
      </header>
      {error ? (
        <p className="text-red-600 text-sm">{error.message}</p>
      ) : !data ? (
        <p className="text-neutral-500 text-sm">Loading…</p>
      ) : data.length === 0 ? (
        <p className="text-neutral-500 text-sm">No departures</p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {data.map((departure) => (
            <DepartureRow
              key={`${departure.tripId}-${departure.serviceDate}`}
              departure={departure}
              now={now}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
