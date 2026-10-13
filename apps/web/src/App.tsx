import { useQueries } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { type Departure, trpc } from "./trpc";

// Keep in step with WATCHED_STOP_IDS in .railway/railway.ts: the Schedule
// only has Departures for watched Stops. A Departure leaving sooner than the
// Walk Time can't be caught, so it isn't shown
const STOPS = [
  {
    stopId: "8250IR0014",
    name: "Dalkey",
    directionId: 0 as const,
    walkTimeSeconds: 600,
  },
  { stopId: "8250DB003062", name: "Breffni Road", walkTimeSeconds: 300 },
  {
    stopId: "8250IR0111",
    name: "Sandycove & Glasthule",
    directionId: 0 as const,
    walkTimeSeconds: 720,
  },
];

const REFETCH_INTERVAL_MS = 30_000;
const ROWS = 10;

const clockTime = new Intl.DateTimeFormat("en-IE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Dublin",
});

export function App() {
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
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function DepartureRow({ departure, now }: { departure: Departure; now: Date }) {
  const { scheduledDeparture, predictedDeparture } = departure;
  const departs = departsAt(departure);
  const dueMinutes = Math.floor((departs.getTime() - now.getTime()) / 60_000);
  const delayMinutes =
    predictedDeparture &&
    Math.round(
      (predictedDeparture.getTime() - scheduledDeparture.getTime()) / 60_000,
    );

  return (
    <li className="flex items-center gap-3 py-2">
      <span
        // Neutral unless the route has colours, which the inline style applies
        className="w-12 shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-center font-semibold text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
        style={{
          backgroundColor: departure.routeColor
            ? `#${departure.routeColor}`
            : undefined,
          color: departure.routeTextColor
            ? `#${departure.routeTextColor}`
            : undefined,
        }}
      >
        {departure.routeShortName ?? "?"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate">{departure.headsign}</p>
        <p className="truncate text-neutral-500 text-xs">
          {departure.stopName}
          {" · "}
          {clockTime.format(departs)}
          {predictedDeparture ? (
            <>
              {" · "}
              <span className="text-green-600">live</span>
              {delayMinutes ? (
                <span className={delayMinutes > 0 ? "text-amber-600" : ""}>
                  {" "}
                  ({delayMinutes > 0 ? "+" : ""}
                  {delayMinutes} min)
                </span>
              ) : null}
            </>
          ) : (
            " · scheduled"
          )}
        </p>
      </div>
      <span className="shrink-0 font-semibold tabular-nums">
        {formatDue(dueMinutes, departs)}
      </span>
    </li>
  );
}

function departsAt(departure: Departure) {
  return departure.predictedDeparture ?? departure.scheduledDeparture;
}

function formatDue(dueMinutes: number, departs: Date) {
  if (dueMinutes <= 0) return "Due";
  if (dueMinutes < 60) return `${dueMinutes} min`;
  return clockTime.format(departs);
}

function formatAgo(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}

/** The current time, ticking every few seconds so "due in" stays fresh */
function useNow(intervalMs = 5_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
