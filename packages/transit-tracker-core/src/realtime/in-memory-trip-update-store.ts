import type {
  TripUpdate,
  TripUpdateFeed,
  TripUpdateSnapshot,
} from "./domain/types";
import { tripUpdateKey } from "./domain/types";
import type { TripUpdateStore } from "./interfaces/outbound/trip-update-store";

/** For one server replica, local development and tests */
export class InMemoryTripUpdateStore implements TripUpdateStore {
  private snapshot: {
    timestamp: Date;
    tripUpdates: Map<string, TripUpdate>;
    expiresAt: number;
  } | null = null;
  private refreshClaimedUntil = Number.NEGATIVE_INFINITY;

  async getTripUpdates(
    keys: readonly string[],
  ): Promise<TripUpdateSnapshot | null> {
    if (!this.snapshot || Date.now() >= this.snapshot.expiresAt) return null;
    const { timestamp, tripUpdates } = this.snapshot;
    return {
      timestamp,
      tripUpdates: new Map(
        keys.flatMap((key) => {
          const tripUpdate = tripUpdates.get(key);
          return tripUpdate ? [[key, tripUpdate] as const] : [];
        }),
      ),
    };
  }

  async replace(
    { timestamp, tripUpdates }: TripUpdateFeed,
    expiresAt: Date,
  ): Promise<void> {
    this.snapshot = {
      timestamp,
      tripUpdates: new Map(
        tripUpdates.map((tripUpdate) => [
          tripUpdateKey(tripUpdate.tripId, tripUpdate.startDate),
          tripUpdate,
        ]),
      ),
      expiresAt: expiresAt.getTime(),
    };
  }

  async claimRefresh(cooldownMs: number): Promise<boolean> {
    const now = Date.now();
    if (now < this.refreshClaimedUntil) return false;
    this.refreshClaimedUntil = now + cooldownMs;
    return true;
  }
}
