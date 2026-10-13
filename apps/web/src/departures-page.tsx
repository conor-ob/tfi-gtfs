import { useCatchableDepartures } from "./catchable-departures";
import { DepartureRow, formatAgo, useNow } from "./departure-row";

const ROWS = 10;

/** Every Stop's catchable Departures as one list, soonest first */
export function DeparturesPage() {
  const now = useNow();
  const { departures, errors, loading, updatedAt } = useCatchableDepartures({
    now,
    limit: ROWS,
  });

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
      {errors.map(({ stop, error }) => (
        <p key={stop.stopId} className="text-red-600 text-sm">
          {stop.name}: {error.message}
        </p>
      ))}
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
