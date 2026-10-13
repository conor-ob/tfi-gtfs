import { useEffect, useState } from "react";

import type { Departure } from "./trpc";

const clockTime = new Intl.DateTimeFormat("en-IE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Dublin",
});

export function DepartureRow({
  departure,
  now,
  showStop = false,
}: {
  departure: Departure;
  now: Date;
  /** Name the Stop, for lists that mix Stops */
  showStop?: boolean;
}) {
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
          {showStop && `${departure.stopName} · `}
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

export function departsAt(departure: Departure) {
  return departure.predictedDeparture ?? departure.scheduledDeparture;
}

function formatDue(dueMinutes: number, departs: Date) {
  if (dueMinutes <= 0) return "Due";
  if (dueMinutes < 60) return `${dueMinutes} min`;
  return clockTime.format(departs);
}

export function formatAgo(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}

/** The current time, ticking every few seconds so "due in" stays fresh */
export function useNow(intervalMs = 5_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
