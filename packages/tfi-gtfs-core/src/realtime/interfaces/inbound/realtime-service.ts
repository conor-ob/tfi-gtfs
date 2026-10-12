import type { TripUpdateSnapshot } from "../../domain/types";

export interface RealtimeService {
  /**
   * The latest Trip Updates for the given `tripUpdateKey`s, or null when
   * there are none recent enough to trust. Starts a background read of the
   * Realtime Feed when one is due.
   */
  getTripUpdates(keys: readonly string[]): Promise<TripUpdateSnapshot | null>;
}
