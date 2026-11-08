import z from "zod";
import { parseRouteStopPairs, RouteStopPairsError } from "./route-stop-pairs";

// The Transit Tracker firmware's WebSocket protocol, as served by
// transit-tracker-api (see docs/adr/0010)

export const listModeSchema = z.enum(["sequential", "nextPerRoute"]);

export type ListMode = z.infer<typeof listModeSchema>;

/** Board → server, on connect and again after every reconnect */
export const subscribeMessageSchema = z.object({
  event: z.literal("schedule:subscribe"),
  data: z.object({
    // A single feed here, so it's ignored
    feedCode: z.string().optional(),
    routeStopPairs: z.string().transform((value, ctx) => {
      try {
        return parseRouteStopPairs(value);
      } catch (error) {
        if (!(error instanceof RouteStopPairsError)) throw error;
        ctx.addIssue({ code: "custom", message: error.message });
        return z.NEVER;
      }
    }),
    limit: z.number().int().min(1).max(20),
    // Arrival and departure times are the same, so it makes no difference
    sortByDeparture: z.boolean().optional(),
    listMode: listModeSchema.default("sequential"),
  }),
});

export type Subscription = z.infer<typeof subscribeMessageSchema>["data"];

export const tripSchema = z.object({
  tripId: z.string(),
  stopId: z.string(),
  /** The plain `route_id`, so the firmware's route styles match */
  routeId: z.string(),
  routeName: z.string(),
  /** Hex without the `#` */
  routeColor: z.string().nullable(),
  headsign: z.string(),
  stopName: z.string(),
  /** Epoch seconds */
  arrivalTime: z.number().int(),
  /** Epoch seconds */
  departureTime: z.number().int(),
  isRealtime: z.boolean(),
  vehicle: z.null(),
});

export type Trip = z.infer<typeof tripSchema>;

/** Server → board */
export const serverMessageSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("heartbeat"), data: z.null() }),
  z.object({
    event: z.literal("schedule"),
    data: z.object({ trips: z.array(tripSchema) }),
  }),
  // The firmware ignores events it doesn't know, so this is for logs and
  // anyone debugging with a WebSocket client
  z.object({
    event: z.literal("error"),
    data: z.object({ message: z.string() }),
  }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
