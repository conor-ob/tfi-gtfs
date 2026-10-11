import type { TripUpdateSnapshot } from "./domain/types";
import type { TripUpdateStore } from "./interfaces/outbound/trip-update-store";

export class InMemoryTripUpdateStore implements TripUpdateStore {
  private snapshot: TripUpdateSnapshot | null = null;

  async get(): Promise<TripUpdateSnapshot | null> {
    return this.snapshot;
  }

  async set(snapshot: TripUpdateSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }
}
