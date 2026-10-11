import type {
  RealtimeFeedClient,
  TripUpdateFeed,
} from "@tfi-gtfs/tfi-gtfs-core";
import { decodeTripUpdateFeed } from "./trip-update-feed";

const TIMEOUT_MS = 10_000;

/** The NTA's GTFS-Realtime TripUpdates endpoint, authenticated by API key */
export class NtaRealtimeFeedClient implements RealtimeFeedClient {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {
    this.url = url;
    this.apiKey = apiKey;
  }

  async fetchTripUpdates(): Promise<TripUpdateFeed> {
    const response = await fetch(this.url, {
      headers: { "x-api-key": this.apiKey, "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(
        `Realtime Feed returned ${response.status} ${response.statusText}: ${body}`,
      );
    }
    return decodeTripUpdateFeed(new Uint8Array(await response.arrayBuffer()));
  }
}
