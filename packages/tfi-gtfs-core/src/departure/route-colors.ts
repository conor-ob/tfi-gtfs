import type { Departure } from "./domain/types";

type RouteColors = { routeColor: string; routeTextColor: string };

// The NTA Schedule has no route colours, so each Agency gets its own (hex
// without the `#`), keyed by `agency_id`
const AGENCY_ROUTE_COLORS: Record<string, RouteColors> = {
  // Irish Rail
  IR: { routeColor: "2F8539", routeTextColor: "FFFFFF" },
  "3": { routeColor: "0052B7", routeTextColor: "FFFFFF" },
  // Dublin Bus
  "1": { routeColor: "F3C936", routeTextColor: "000000" },
};

/**
 * Fills a Departure's empty route colours from its Agency's defaults. The
 * feed's own colours win, and an Agency with no defaults keeps null.
 */
export function withRouteColors(departure: Departure): Departure {
  const defaults = AGENCY_ROUTE_COLORS[departure.agencyId];
  if (!defaults) return departure;
  return {
    ...departure,
    routeColor: departure.routeColor || defaults.routeColor,
    routeTextColor: departure.routeTextColor || defaults.routeTextColor,
  };
}
