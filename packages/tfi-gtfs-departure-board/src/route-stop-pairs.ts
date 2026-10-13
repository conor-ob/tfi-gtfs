/** One `route,stop[,offset]` entry of the board's schedule string */
export type RouteStopPair = {
  /** A `route_id`, or null for every Route at the Stop (`*`) */
  routeId: string | null;
  /** Only Trips in this direction (`:0` / `:1` suffix); undefined for both */
  directionId?: 0 | 1;
  stopId: string;
  /** Departures leaving sooner than this many seconds from now are hidden */
  walkTimeSeconds: number;
};

export class RouteStopPairsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteStopPairsError";
  }
}

const ANY_ROUTE = "*";

/**
 * Parses `routeStopPairs`: pairs joined by `;`, each `route,stop[,offset]`.
 * The route is a `route_id` or `*`, with an optional `:0`/`:1` direction
 * suffix split at the last `:` (NTA `route_id`s contain spaces but no colons).
 * The offset is the Walk Time as a negative number of seconds (ADR 0010).
 */
export function parseRouteStopPairs(value: string): RouteStopPair[] {
  if (value === "") throw new RouteStopPairsError("No route/stop pairs");
  return value.split(";").map(parsePair);
}

function parsePair(pair: string): RouteStopPair {
  const parts = pair.split(",");
  const [route, stopId, offset] = parts;
  if (parts.length > 3 || !route || !stopId) {
    throw new RouteStopPairsError(
      `Expected 'route,stop[,offset]' but got '${pair}'`,
    );
  }
  return {
    ...parseRoute(route),
    stopId,
    walkTimeSeconds: offset === undefined ? 0 : parseWalkTime(offset),
  };
}

function parseRoute(
  route: string,
): Pick<RouteStopPair, "routeId" | "directionId"> {
  const colon = route.lastIndexOf(":");
  const routeId = colon === -1 ? route : route.slice(0, colon);
  if (!routeId) throw new RouteStopPairsError(`No route in '${route}'`);
  if (colon === -1) return { routeId: toRouteId(routeId) };

  const direction = route.slice(colon + 1);
  if (direction !== "0" && direction !== "1") {
    throw new RouteStopPairsError(
      `Direction must be 0 or 1 but got '${direction}' in '${route}'`,
    );
  }
  return {
    routeId: toRouteId(routeId),
    directionId: direction === "0" ? 0 : 1,
  };
}

function toRouteId(route: string): string | null {
  return route === ANY_ROUTE ? null : route;
}

function parseWalkTime(offset: string): number {
  if (!/^-?\d+$/.test(offset)) {
    throw new RouteStopPairsError(
      `Offset must be whole seconds but got '${offset}'`,
    );
  }
  const seconds = Number(offset);
  if (seconds > 0) {
    throw new RouteStopPairsError(
      `Offset is the Walk Time and must be 0 or less, but got '${offset}'`,
    );
  }
  return -seconds || 0;
}
