import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { type Departure, trpc } from "./trpc";

// Keep in step with WATCHED_STOP_IDS in .railway/railway.ts: the Schedule
// only has Departures for watched Stops
const STOPS = [
  { stopId: "8250IR0014", name: "Dalkey", directionId: 0 as const },
  { stopId: "8250DB003062", name: "Breffni Road" },
  {
    stopId: "8250IR0111",
    name: "Sandycove & Glasthule",
    directionId: 0 as const,
  },
];

// Route pill colours by Agency, with neutral for any other Agency
const AGENCY_PILL_CLASSES: Record<string, string> = {
  IR: "bg-[#2F8539] text-white",
  "3": "bg-[#0052B7] text-white",
  "1": "bg-[#F3C936] text-black",
};

const REFETCH_INTERVAL_MS = 30_000;

const clockTime = new Intl.DateTimeFormat("en-IE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Dublin",
});

export function App() {
  const now = useNow();

  return (
    <main className="mx-auto max-w-md space-y-8 px-4 py-6">
      {STOPS.map((stop) => (
        <StopDepartures key={stop.stopId} {...stop} now={now} />
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
      limit: 5,
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

function DepartureRow({ departure, now }: { departure: Departure; now: Date }) {
  const { scheduledDeparture, predictedDeparture } = departure;
  const departs = predictedDeparture ?? scheduledDeparture;
  const dueMinutes = Math.floor((departs.getTime() - now.getTime()) / 60_000);
  const delayMinutes =
    predictedDeparture &&
    Math.round(
      (predictedDeparture.getTime() - scheduledDeparture.getTime()) / 60_000,
    );

  return (
    <li className="flex items-center gap-3 py-2">
      <span
        className={`w-12 shrink-0 rounded px-1.5 py-0.5 text-center font-semibold text-sm ${
          AGENCY_PILL_CLASSES[departure.agencyId] ??
          "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
        }`}
      >
        {departure.routeShortName ?? "?"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate">{departure.headsign}</p>
        <p className="text-neutral-500 text-xs">
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
