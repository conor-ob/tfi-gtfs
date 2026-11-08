import type { TripUpdateFeed, TripUpdateSnapshot } from "../../domain/types";

/**
 * Holds the latest Trip Updates, keyed by `tripUpdateKey`, and the cooldown
 * between reads of the Realtime Feed. In memory or in Redis (see
 * docs/adr/0009-trip-updates-cached-in-redis-refreshed-on-read.md).
 */
export interface TripUpdateStore {
  /**
   * The latest snapshot, holding only the asked-for Trip Updates that exist,
   * or null when none has been stored or it has expired
   */
  getTripUpdates(keys: readonly string[]): Promise<TripUpdateSnapshot | null>;
  /** Replaces the whole snapshot at once; it expires at `expiresAt` */
  replace(feed: TripUpdateFeed, expiresAt: Date): Promise<void>;
  /**
   * Claims the next read of the Realtime Feed. False while an earlier claim
   * is less than `cooldownMs` old, whether or not its read succeeded
   */
  claimRefresh(cooldownMs: number): Promise<boolean>;
}
