import type { TripUpdateSnapshot } from "./domain/types";
import type { RealtimeService } from "./interfaces/inbound/realtime-service";
import type { RealtimeFeedClient } from "./interfaces/outbound/realtime-feed-client";
import type { TripUpdateStore } from "./interfaces/outbound/trip-update-store";

export type RealtimeOptions = {
  /** Least time between reads of the Realtime Feed; the API key is rate limited */
  refreshIntervalMs: number;
  /** Treat Trip Updates older than this, by the feed's timestamp, as none */
  maxAgeMs: number;
  /** How long a request with no Trip Updates at all waits for a read */
  coldWaitMs: number;
  onError: (error: unknown) => void;
};

export const DEFAULT_REALTIME_OPTIONS: RealtimeOptions = {
  refreshIntervalMs: 60_000,
  maxAgeMs: 5 * 60_000,
  coldWaitMs: 2_000,
  onError: () => {},
};

/**
 * Reads the Realtime Feed when a request finds the last read more than one
 * interval old (see
 * docs/adr/0009-trip-updates-cached-in-redis-refreshed-on-read.md). The
 * request serves the Trip Updates it has without waiting, unless it has none
 * at all.
 */
export class RealtimeServiceImpl implements RealtimeService {
  private readonly options: RealtimeOptions;
  /** This process's read of the Realtime Feed, while one is under way */
  private inFlight: Promise<boolean> | null = null;

  constructor(
    private readonly realtimeFeedClient: RealtimeFeedClient,
    private readonly tripUpdateStore: TripUpdateStore,
    options: Partial<RealtimeOptions> = {},
  ) {
    this.realtimeFeedClient = realtimeFeedClient;
    this.tripUpdateStore = tripUpdateStore;
    this.options = { ...DEFAULT_REALTIME_OPTIONS, ...options };
  }

  async getTripUpdates(
    keys: readonly string[],
  ): Promise<TripUpdateSnapshot | null> {
    const [snapshot, claimed] = await Promise.all([
      this.read(keys),
      this.claimRefresh(),
    ]);
    if (claimed) this.startRefresh();
    if (snapshot) return snapshot;

    // Nothing to serve yet, so give a read under way a moment to land, even
    // one claimed by another request (the page asks for every Stop at once)
    const refresh = this.inFlight;
    if (!refresh) return null;
    if (await withTimeout(refresh, this.options.coldWaitMs)) {
      return this.read(keys);
    }
    return null;
  }

  /** Never rejects: Departures must not fail because of Trip Updates */
  private async read(keys: readonly string[]) {
    try {
      return await this.tripUpdateStore.getTripUpdates(keys);
    } catch (error) {
      this.options.onError(error);
      return null;
    }
  }

  private async claimRefresh() {
    try {
      return await this.tripUpdateStore.claimRefresh(
        this.options.refreshIntervalMs,
      );
    } catch (error) {
      this.options.onError(error);
      return false;
    }
  }

  private startRefresh() {
    const refresh = this.refresh();
    this.inFlight = refresh;
    void refresh.then(() => {
      if (this.inFlight === refresh) this.inFlight = null;
    });
  }

  /** Resolves true once fresh Trip Updates are stored */
  private async refresh(): Promise<boolean> {
    try {
      const feed = await this.realtimeFeedClient.fetchTripUpdates();
      const expiresAt = feed.timestamp.getTime() + this.options.maxAgeMs;
      if (expiresAt <= Date.now()) return false;
      await this.tripUpdateStore.replace(feed, new Date(expiresAt));
      return true;
    } catch (error) {
      this.options.onError(error);
      return false;
    }
  }
}

/** The promise's value, or false if it takes longer than `ms` */
async function withTimeout(
  promise: Promise<boolean>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
