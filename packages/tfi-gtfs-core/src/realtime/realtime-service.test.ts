import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TripUpdate, TripUpdateFeed } from "./domain/types";
import { InMemoryTripUpdateStore } from "./in-memory-trip-update-store";
import type { RealtimeFeedClient } from "./interfaces/outbound/realtime-feed-client";
import { RealtimeServiceImpl } from "./realtime-service";

const MINUTE = 60_000;

const tripUpdate: TripUpdate = {
  tripId: "t1",
  startDate: "2026-12-02",
  canceled: false,
  delay: 120,
  stopTimeUpdates: [],
};

/** Answers with a feed produced 10 seconds before each request */
function fakeClient() {
  const fetchTripUpdates = vi.fn(
    async (): Promise<TripUpdateFeed> => ({
      timestamp: new Date(Date.now() - 10_000),
      tripUpdates: [tripUpdate],
    }),
  );
  const client: RealtimeFeedClient = { fetchTripUpdates };
  return { client, fetchTripUpdates };
}

describe("RealtimeServiceImpl", () => {
  let service: RealtimeServiceImpl | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-02T10:00:00Z"));
  });

  afterEach(() => {
    service?.stop();
    vi.useRealTimers();
  });

  function create(client: RealtimeFeedClient, onError = vi.fn()) {
    service = new RealtimeServiceImpl(client, new InMemoryTripUpdateStore(), {
      pollIntervalMs: MINUTE,
      idleAfterMs: 5 * MINUTE,
      maxAgeMs: 3 * MINUTE,
      onError,
    });
    return service;
  }

  it("doesn't poll until someone asks for Trip Updates", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    create(client);

    await vi.advanceTimersByTimeAsync(10 * MINUTE);

    expect(fetchTripUpdates).not.toHaveBeenCalled();
  });

  it("wakes on the first request without waiting for the poll", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const service = create(client);

    expect(await service.getTripUpdates()).toBeNull();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchTripUpdates).toHaveBeenCalledOnce();
    const snapshot = await service.getTripUpdates();
    expect(snapshot?.tripUpdates.get("2026-12-02/t1")).toEqual(tripUpdate);
  });

  it("polls once per interval however many requests arrive", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const service = create(client);

    for (let i = 0; i < 6; i++) {
      await service.getTripUpdates();
      await vi.advanceTimersByTimeAsync(MINUTE / 3);
    }

    // At 0, 1 and 2 minutes
    expect(fetchTripUpdates).toHaveBeenCalledTimes(3);
  });

  it("goes back to sleep when nobody asks, and wakes no sooner than an interval after the last poll", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const service = create(client);

    await service.getTripUpdates();
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    // Polls at 0 to 5 minutes, then the poll at 6 minutes finds it idle
    expect(fetchTripUpdates).toHaveBeenCalledTimes(6);

    await service.getTripUpdates();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTripUpdates).toHaveBeenCalledTimes(7);
  });

  it("treats an old snapshot as none", async () => {
    const { client } = fakeClient();
    const service = create(client);
    await service.getTripUpdates();
    await vi.advanceTimersByTimeAsync(0);

    // Asleep after 6 minutes, so the snapshot from 5 minutes is left to age
    await vi.advanceTimersByTimeAsync(9 * MINUTE);

    expect(await service.getTripUpdates()).toBeNull();
  });

  it("reports a failed poll and keeps polling", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const error = new Error("429 Too Many Requests");
    fetchTripUpdates.mockRejectedValueOnce(error);
    const onError = vi.fn();
    const service = create(client, onError);

    await service.getTripUpdates();
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(onError).toHaveBeenCalledWith(error);
    expect(await service.getTripUpdates()).not.toBeNull();
  });

  it("stops polling when stopped", async () => {
    const { client, fetchTripUpdates } = fakeClient();
    const service = create(client);
    await service.getTripUpdates();
    await vi.advanceTimersByTimeAsync(0);

    service.stop();
    await service.getTripUpdates();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(fetchTripUpdates).toHaveBeenCalledOnce();
  });
});
