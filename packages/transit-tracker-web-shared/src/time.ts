import { useEffect, useState } from "react";

import type { Departure } from "./trpc";

export function departsAt(departure: Departure) {
  return departure.predictedDeparture ?? departure.scheduledDeparture;
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
