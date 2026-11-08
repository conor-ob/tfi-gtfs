import type { TripUpdate } from "../realtime/domain/types";
import type { Departure } from "./domain/types";

/**
 * Applies a Departure's Trip Update, or returns null when the Trip is
 * cancelled or no longer stops here. A Stop with no Stop Time Update of its own
 * takes the Delay of the last one before it, then the Trip's own Delay.
 */
export function predictDeparture(
  departure: Departure,
  tripUpdate: TripUpdate | undefined,
): Departure | null {
  if (!tripUpdate) return departure;
  if (tripUpdate.canceled) return null;

  let delay = tripUpdate.delay;
  for (const update of tripUpdate.stopTimeUpdates) {
    if (update.stopSequence > departure.stopSequence) break;
    if (update.stopSequence === departure.stopSequence && update.skipped) {
      return null;
    }
    if (update.delay != null) delay = update.delay;
  }

  return {
    ...departure,
    predictedDeparture:
      delay == null
        ? null
        : new Date(departure.scheduledDeparture.getTime() + delay * 1000),
  };
}
