import {
  type TripUpdate,
  type TripUpdateFeed,
  type TripUpdateSnapshot,
  type TripUpdateStore,
  tripUpdateKey,
} from "@tfi-gtfs/tfi-gtfs-core";
import type { RedisClientType } from "redis";

export type RedisTripUpdateStoreKeys = {
  /** Hash of JSON Trip Updates, keyed by `tripUpdateKey` */
  tripUpdates: string;
  /** The snapshot's feed timestamp, in epoch milliseconds */
  timestamp: string;
  /** Present while a read of the Realtime Feed is in its cooldown */
  refresh: string;
};

export const DEFAULT_KEYS: RedisTripUpdateStoreKeys = {
  tripUpdates: "realtime:trip-updates",
  timestamp: "realtime:timestamp",
  refresh: "realtime:refresh",
};

/**
 * Trip Updates in Redis (see
 * docs/adr/0009-trip-updates-cached-in-redis-refreshed-on-read.md). Reads and
 * replaces both keys in one MULTI, so a reader never sees half a snapshot.
 */
export class RedisTripUpdateStore implements TripUpdateStore {
  constructor(
    private readonly client: RedisClientType,
    private readonly keys: RedisTripUpdateStoreKeys = DEFAULT_KEYS,
  ) {
    this.client = client;
    this.keys = keys;
  }

  async getTripUpdates(
    keys: readonly string[],
  ): Promise<TripUpdateSnapshot | null> {
    const multi = this.client.multi().get(this.keys.timestamp);
    // HMGET needs at least one field
    if (keys.length > 0) multi.hmGet(this.keys.tripUpdates, [...keys]);
    const [timestamp, values = []] = (await multi.exec()) as unknown as [
      string | null,
      (string | null)[]?,
    ];
    if (timestamp === null) return null;

    return {
      timestamp: new Date(Number(timestamp)),
      tripUpdates: new Map(
        keys.flatMap((key, i) => {
          const value = values[i];
          return value ? [[key, JSON.parse(value) as TripUpdate] as const] : [];
        }),
      ),
    };
  }

  async replace(
    { timestamp, tripUpdates }: TripUpdateFeed,
    expiresAt: Date,
  ): Promise<void> {
    const multi = this.client
      .multi()
      .del(this.keys.tripUpdates)
      .set(this.keys.timestamp, String(timestamp.getTime()), {
        expiration: { type: "PXAT", value: expiresAt.getTime() },
      });
    // HSET needs at least one field; an empty feed is no Trip Updates
    if (tripUpdates.length > 0) {
      multi
        .hSet(
          this.keys.tripUpdates,
          Object.fromEntries(
            tripUpdates.map((tripUpdate) => [
              tripUpdateKey(tripUpdate.tripId, tripUpdate.startDate),
              JSON.stringify(tripUpdate),
            ]),
          ),
        )
        .pExpireAt(this.keys.tripUpdates, expiresAt.getTime());
    }
    await multi.exec();
  }

  async claimRefresh(cooldownMs: number): Promise<boolean> {
    const reply = await this.client.set(this.keys.refresh, String(Date.now()), {
      condition: "NX",
      expiration: { type: "PX", value: cooldownMs },
    });
    return reply === "OK";
  }
}
