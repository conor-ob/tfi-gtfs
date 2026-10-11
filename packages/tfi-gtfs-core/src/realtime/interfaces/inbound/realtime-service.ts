import type { TripUpdateSnapshot } from "../../domain/types";

export interface RealtimeService {
  /**
   * The latest Trip Updates, or null when there are none recent enough to
   * trust. Each call keeps the poller awake, and wakes it if it is asleep.
   */
  getTripUpdates(): Promise<TripUpdateSnapshot | null>;
  /** Stops polling, e.g. when the server shuts down */
  stop(): void;
}
