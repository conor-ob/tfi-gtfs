// Keep in step with WATCHED_STOP_IDS in .railway/railway.ts: the Schedule
// only has Departures for watched Stops. A Departure leaving sooner than the
// Walk Time can't be caught, so apps/web's merged list doesn't show it
export const STOPS = [
  {
    stopId: "8250IR0014",
    name: "Dalkey",
    directionId: 0 as const,
    walkTimeSeconds: 600,
  },
  {
    stopId: "8250IR0111",
    name: "Sandycove & Glasthule",
    directionId: 0 as const,
    walkTimeSeconds: 720,
  },
  { stopId: "8250DB003062", name: "Breffni Road", walkTimeSeconds: 300 },
];

export const REFETCH_INTERVAL_MS = 30_000;
