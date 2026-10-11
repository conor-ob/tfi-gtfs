import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { describe, expect, it } from "vitest";
import { decodeTripUpdateFeed } from "./trip-update-feed";

const { transit_realtime: rt } = GtfsRealtimeBindings;
const Trip = rt.TripDescriptor.ScheduleRelationship;
const Stop = rt.TripUpdate.StopTimeUpdate.ScheduleRelationship;

function encode(entity: GtfsRealtimeBindings.transit_realtime.IFeedEntity[]) {
  return rt.FeedMessage.encode({
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: rt.FeedHeader.Incrementality.FULL_DATASET,
      timestamp: 1_796_206_866,
    },
    entity,
  }).finish();
}

describe("decodeTripUpdateFeed", () => {
  it("reads the feed time and each Trip's Delays in Stop order", () => {
    const feed = decodeTripUpdateFeed(
      encode([
        {
          id: "1",
          tripUpdate: {
            trip: {
              tripId: "5240_1",
              startDate: "20261011",
              scheduleRelationship: Trip.SCHEDULED,
            },
            delay: 90,
            stopTimeUpdate: [
              { stopSequence: 9, stopId: "s9", arrival: { delay: 30 } },
              {
                stopSequence: 4,
                stopId: "s4",
                arrival: { delay: 60 },
                departure: { delay: 75 },
              },
              // A departure with only a time falls back to the arrival Delay
              {
                stopSequence: 5,
                stopId: "s5",
                arrival: { delay: 45 },
                departure: { time: 1_796_207_000 },
              },
              {
                stopSequence: 6,
                stopId: "s6",
                scheduleRelationship: Stop.SKIPPED,
              },
              {
                stopSequence: 7,
                stopId: "s7",
                scheduleRelationship: Stop.NO_DATA,
                departure: { delay: 10 },
              },
            ],
          },
        },
      ]),
    );

    expect(feed).toStrictEqual({
      timestamp: new Date("2026-12-02T10:21:06Z"),
      tripUpdates: [
        {
          tripId: "5240_1",
          startDate: "2026-10-11",
          canceled: false,
          delay: 90,
          stopTimeUpdates: [
            { stopSequence: 4, stopId: "s4", skipped: false, delay: 75 },
            { stopSequence: 5, stopId: "s5", skipped: false, delay: 45 },
            { stopSequence: 6, stopId: "s6", skipped: true, delay: null },
            { stopSequence: 7, stopId: "s7", skipped: false, delay: null },
            { stopSequence: 9, stopId: "s9", skipped: false, delay: 30 },
          ],
        },
      ],
    });
  });

  it("keeps cancelled Trips and drops ADDED ones", () => {
    const feed = decodeTripUpdateFeed(
      encode([
        {
          id: "1",
          tripUpdate: {
            trip: {
              tripId: "t1",
              startDate: "20261011",
              scheduleRelationship: Trip.CANCELED,
            },
          },
        },
        {
          id: "2",
          tripUpdate: {
            trip: {
              routeId: "2 51 c b",
              startDate: "20261011",
              scheduleRelationship: Trip.ADDED,
            },
          },
        },
      ]),
    );

    expect(feed.tripUpdates).toEqual([
      {
        tripId: "t1",
        startDate: "2026-10-11",
        canceled: true,
        delay: null,
        stopTimeUpdates: [],
      },
    ]);
  });
});
