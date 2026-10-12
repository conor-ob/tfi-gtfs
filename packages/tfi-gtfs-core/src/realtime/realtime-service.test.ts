import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TripUpdate, TripUpdateFeed } from "./domain/types";
import { InMemoryTripUpdateStore } from "./in-memory-trip-update-store";
import type { RealtimeFeedClient } from "./interfaces/outbound/realtime-feed-client";
import type { TripUpdateStore } from "./interfaces/outbound/trip-update-store";
import { RealtimeServiceImpl } from "./realtime-service";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const tripUpdate = (tripId: string, delay = 120): TripUpdate => ({
  tripId,
  startDate: "2026-12-02",
  canceled: false,
  delay,
  stopTimeUpdates: [],
});

const KEYS = ["2026-12-02/t1"];

/** Answers with a feed produced 10 seconds before each request */
function fakeClient() {
  const fetchTripUpdates = vi.fn(
    async (): Promise<TripUpdateFeed> => ({
      timestamp: new Date(Date.now() - 10 * SECOND),
      tripUpdates: [tripUpdate("t1"), tripUpdate("t2")],
    }),
  );
  const client: RealtimeFeedClient = { fetchTripUpdates };
  return { client, fetchTripUpdates };
}

/** A feed read that lands when `land` is called */
function pending() {
  let land = () => {};
  const promise = new Promise<TripUpdateFeed>((resolve) => {
    land = () =>
      resolve({
        timestamp: new Date(Date.now() - 10 * SECOND),
        tripUpdates: [tripUpdate("t1", 300)],
      });
  });
  return { promise, land: () => land() };
}

describe("RealtimeServiceImpl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-02T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function create(
    client: RealtimeFeedClient,
    {
      onError = vi.fn(),
      store = new InMemoryTripUpdateStore(),
    }: { onError?: () => void; store?: TripUpdateStore } = {},
  ) {
    return new RealtimeServiceImpl(client, store, {
      refreshIntervalMs: MINUTE,
      maxAgeMs: 3 * MINUTE,
      coldWaitMs: 2 * SECOND,
      onError,
    });
  }

  it("doesn't read the Realtime Feed until someone asks", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    create(client);

    await vi.advanceTimersByTimeAsync(10 * MINUTE);

    expect(fetchTripUpdates).not.toHaveBeenCalled();
  });

  it("waits for the first read when it has no Trip Updates at all", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const service = create(client);

    const snapshot = await service.getTripUpdates(KEYS);

    expect(fetchTripUpdates).toHaveBeenCalledOnce();
    // Only the asked-for Trips
    expect(snapshot?.tripUpdates).toEqual(
      new Map([["2026-12-02/t1", tripUpdate("t1")]]),
    );
  });

  it("serves the Trip Updates it has while a due read is under way", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const service = create(client);
    await service.getTripUpdates(KEYS);
    await vi.advanceTimersByTimeAsync(MINUTE);
    const read = pending();
    fetchTripUpdates.mockReturnValueOnce(read.promise);

    const stale = await service.getTripUpdates(KEYS);
    read.land();
    await vi.advanceTimersByTimeAsync(0);
    const fresh = await service.getTripUpdates(KEYS);

    expect(fetchTripUpdates).toHaveBeenCalledTimes(2);
    expect(stale?.tripUpdates.get(KEYS[0] as string)?.delay).toBe(120);
    expect(fresh?.tripUpdates.get(KEYS[0] as string)?.delay).toBe(300);
  });

  it("reads once per interval however many requests arrive", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const service = create(client);

    for (let i = 0; i < 7; i++) {
      await service.getTripUpdates(KEYS);
      await vi.advanceTimersByTimeAsync(MINUTE / 3);
    }

    // At 0, 1 and 2 minutes
    expect(fetchTripUpdates).toHaveBeenCalledTimes(3);
  });

  it("gives up waiting on a slow first read, and serves it once it lands", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const read = pending();
    fetchTripUpdates.mockReturnValueOnce(read.promise);
    const service = create(client);

    const waiting = service.getTripUpdates(KEYS);
    // Another request meanwhile neither reads nor waits
    expect(await service.getTripUpdates(KEYS)).toBeNull();
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    expect(await waiting).toBeNull();

    read.land();
    await vi.advanceTimersByTimeAsync(0);
    expect(await service.getTripUpdates(KEYS)).not.toBeNull();
    expect(fetchTripUpdates).toHaveBeenCalledOnce();
  });

  it("reports a failed read and tries again after an interval, not before", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const error = new Error("429 Too Many Requests");
    fetchTripUpdates.mockRejectedValueOnce(error);
    const onError = vi.fn();
    const service = create(client, { onError });

    expect(await service.getTripUpdates(KEYS)).toBeNull();
    expect(onError).toHaveBeenCalledWith(error);
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(await service.getTripUpdates(KEYS)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(await service.getTripUpdates(KEYS)).not.toBeNull();
    expect(fetchTripUpdates).toHaveBeenCalledTimes(2);
  });

  it("treats Trip Updates older than the max age as none", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const service = create(client);
    await service.getTripUpdates(KEYS);
    fetchTripUpdates.mockRejectedValueOnce(new Error("503"));

    // Produced 10 seconds before the first read, so too old after this
    await vi.advanceTimersByTimeAsync(3 * MINUTE - 10 * SECOND);

    expect(await service.getTripUpdates(KEYS)).toBeNull();
  });

  it("doesn't store a feed that is already too old", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    fetchTripUpdates.mockResolvedValueOnce({
      timestamp: new Date(Date.now() - 4 * MINUTE),
      tripUpdates: [tripUpdate("t1")],
    });
    const service = create(client);

    expect(await service.getTripUpdates(KEYS)).toBeNull();
  });

  it("serves no Trip Updates when the store fails, rather than throwing", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const error = new Error("ECONNREFUSED");
    const store: TripUpdateStore = {
      getTripUpdates: async () => Promise.reject(error),
      replace: async () => Promise.reject(error),
      claimRefresh: async () => Promise.reject(error),
    };
    const onError = vi.fn();
    const service = create(client, { onError, store });

    expect(await service.getTripUpdates(KEYS)).toBeNull();
    expect(onError).toHaveBeenCalledWith(error);
    // Without a claim, the Realtime Feed isn't read at all
    expect(fetchTripUpdates).not.toHaveBeenCalled();
  });
});
