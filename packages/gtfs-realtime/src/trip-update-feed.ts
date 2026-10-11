import type {
  StopTimeUpdate,
  TripUpdate,
  TripUpdateFeed,
} from "@tfi-gtfs/tfi-gtfs-core";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const { transit_realtime: rt } = GtfsRealtimeBindings;
const TripRelationship = rt.TripDescriptor.ScheduleRelationship;
const StopRelationship = rt.TripUpdate.StopTimeUpdate.ScheduleRelationship;

type Long = { toNumber(): number };
const toNumber = (v: number | Long | null | undefined) =>
  v == null ? null : typeof v === "number" ? v : v.toNumber();

/**
 * A field the message actually carries. Decoded messages fall back to proto
 * defaults (`0`, `""`) for missing fields, so an absent Delay would otherwise
 * read as on time.
 */
function present<T extends object, K extends keyof T>(
  message: T | null | undefined,
  key: K,
): NonNullable<T[K]> | null {
  return message != null && Object.hasOwn(message, key)
    ? (message[key] ?? null)
    : null;
}

/** Decodes a TripUpdates protobuf response */
export function decodeTripUpdateFeed(body: Uint8Array): TripUpdateFeed {
  return toTripUpdateFeed(rt.FeedMessage.decode(body));
}

/**
 * Keeps the Trip Updates that refer to a Trip in the Schedule: SCHEDULED and
 * CANCELED ones with a `trip_id` and `start_date`. ADDED Trips are ignored for
 * now (see docs/adr/0001).
 */
export function toTripUpdateFeed(
  feed: GtfsRealtimeBindings.transit_realtime.IFeedMessage,
): TripUpdateFeed {
  const tripUpdates: TripUpdate[] = [];
  for (const entity of feed.entity ?? []) {
    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate || entity.isDeleted) continue;
    const { tripId, startDate, scheduleRelationship } = tripUpdate.trip;
    if (!tripId || !startDate || !/^\d{8}$/.test(startDate)) continue;
    const relationship = scheduleRelationship ?? TripRelationship.SCHEDULED;
    if (
      relationship !== TripRelationship.SCHEDULED &&
      relationship !== TripRelationship.CANCELED
    ) {
      continue;
    }

    tripUpdates.push({
      tripId,
      startDate: `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6)}`,
      canceled: relationship === TripRelationship.CANCELED,
      delay: present(tripUpdate, "delay"),
      stopTimeUpdates: (tripUpdate.stopTimeUpdate ?? [])
        .flatMap((update): StopTimeUpdate[] => {
          const stopSequence = present(update, "stopSequence");
          if (stopSequence == null || !update.stopId) return [];
          const delay =
            present(update.departure, "delay") ??
            present(update.arrival, "delay");
          return [
            {
              stopSequence,
              stopId: update.stopId,
              skipped: update.scheduleRelationship === StopRelationship.SKIPPED,
              delay:
                update.scheduleRelationship === StopRelationship.NO_DATA
                  ? null
                  : delay,
            },
          ];
        })
        .sort((a, b) => a.stopSequence - b.stopSequence),
    });
  }
  return {
    timestamp: new Date((toNumber(feed.header.timestamp) ?? 0) * 1000),
    tripUpdates,
  };
}
