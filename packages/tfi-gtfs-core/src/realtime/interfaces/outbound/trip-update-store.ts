import type { TripUpdateSnapshot } from "../../domain/types";

/**
 * Holds the latest Trip Update snapshot. In memory for now; a shared store
 * such as Redis can replace it once there are several server replicas (see
 * docs/adr/0005-realtime-polled-on-demand-in-server-memory.md).
 */
export interface TripUpdateStore {
  get(): Promise<TripUpdateSnapshot | null>;
  set(snapshot: TripUpdateSnapshot): Promise<void>;
}
