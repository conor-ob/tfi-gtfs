import {
  type TripUpdateFeed,
  type TripUpdateSnapshot,
  tripUpdateKey,
} from "./domain/types";
import type { RealtimeService } from "./interfaces/inbound/realtime-service";
import type { RealtimeFeedClient } from "./interfaces/outbound/realtime-feed-client";
import type { TripUpdateStore } from "./interfaces/outbound/trip-update-store";

export type RealtimeOptions = {
  /** Time between reads of the Realtime Feed; the API key is rate limited */
  pollIntervalMs: number;
  /** Stop polling when nobody has asked for Trip Updates for this long */
  idleAfterMs: number;
  /** Treat a snapshot older than this as no Trip Updates at all */
  maxAgeMs: number;
  onError: (error: unknown) => void;
};

export const DEFAULT_REALTIME_OPTIONS: RealtimeOptions = {
  pollIntervalMs: 60_000,
  idleAfterMs: 10 * 60_000,
  maxAgeMs: 5 * 60_000,
  onError: () => {},
};

/**
 * Polls the Realtime Feed only while someone is asking for Trip Updates (see
 * docs/adr/0005-realtime-polled-on-demand-in-server-memory.md). The first
 * request after an idle spell wakes the poller but doesn't wait for it.
 */
export class RealtimeServiceImpl implements RealtimeService {
  private readonly options: RealtimeOptions;
  private lastDemandAt = Number.NEGATIVE_INFINITY;
  private lastPollAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private stopped = false;

  constructor(
    private readonly realtimeFeedClient: RealtimeFeedClient,
    private readonly tripUpdateStore: TripUpdateStore,
    options: Partial<RealtimeOptions> = {},
  ) {
    this.realtimeFeedClient = realtimeFeedClient;
    this.tripUpdateStore = tripUpdateStore;
    this.options = { ...DEFAULT_REALTIME_OPTIONS, ...options };
  }

  async getTripUpdates(): Promise<TripUpdateSnapshot | null> {
    this.lastDemandAt = Date.now();
    this.wake();
    const snapshot = await this.tripUpdateStore.get();
    if (
      !snapshot ||
      Date.now() - snapshot.timestamp.getTime() > this.options.maxAgeMs
    ) {
      return null;
    }
    return snapshot;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private wake() {
    if (this.timer || this.polling || this.stopped) return;
    this.scheduleNextPoll();
  }

  /** Never polls sooner than one interval after the last poll, even on waking */
  private scheduleNextPoll() {
    const delay = Math.max(
      0,
      this.lastPollAt + this.options.pollIntervalMs - Date.now(),
    );
    this.timer = setTimeout(() => void this.poll(), delay);
    // Don't keep the process alive just to poll
    this.timer.unref?.();
  }

  private async poll() {
    this.timer = null;
    if (Date.now() - this.lastDemandAt > this.options.idleAfterMs) return;

    this.polling = true;
    this.lastPollAt = Date.now();
    try {
      const feed = await this.realtimeFeedClient.fetchTripUpdates();
      await this.tripUpdateStore.set(toSnapshot(feed));
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.polling = false;
    }
    if (!this.stopped) this.scheduleNextPoll();
  }
}

function toSnapshot({ timestamp, tripUpdates }: TripUpdateFeed) {
  return {
    timestamp,
    tripUpdates: new Map(
      tripUpdates.map((tripUpdate) => [
        tripUpdateKey(tripUpdate.tripId, tripUpdate.startDate),
        tripUpdate,
      ]),
    ),
  };
}
