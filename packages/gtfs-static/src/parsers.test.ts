import { describe, expect, it } from "vitest";
import { parsers } from "./parsers";

describe("parsers", () => {
  it("parses a Stop Time past midnight into seconds of the Service Day", () => {
    const stopTime = parsers.stop_times({
      trip_id: "5760_1",
      arrival_time: "24:52:00",
      departure_time: "24:53:30",
      stop_id: "8220B1351201",
      stop_sequence: "1",
      stop_headsign: "",
      pickup_type: "0",
      drop_off_type: "1",
      timepoint: "1",
    });

    expect(stopTime).toEqual({
      tripId: "5760_1",
      arrivalTime: 89_520,
      departureTime: 89_610,
      stopId: "8220B1351201",
      stopSequence: 1,
      stopHeadsign: null,
      pickupType: 0,
      dropOffType: 1,
      timepoint: 1,
    });
  });

  it("parses single-digit hours", () => {
    const stopTime = parsers.stop_times({
      trip_id: "t",
      arrival_time: "6:05:00",
      departure_time: "6:05:00",
      stop_id: "s",
      stop_sequence: "1",
    });

    expect(stopTime.departureTime).toBe(21_900);
  });

  it("parses calendar weekdays and dates", () => {
    const calendar = parsers.calendar({
      service_id: "32",
      monday: "0",
      tuesday: "0",
      wednesday: "0",
      thursday: "0",
      friday: "0",
      saturday: "1",
      sunday: "0",
      start_date: "20261010",
      end_date: "20261011",
    });

    expect(calendar).toMatchObject({
      saturday: true,
      sunday: false,
      startDate: "2026-10-10",
      endDate: "2026-10-11",
    });
  });

  it("treats missing and empty optional columns as null", () => {
    const stop = parsers.stops({
      stop_id: "7010B158131",
      stop_name: "Derry Bus Station",
      stop_lat: "54.996629",
      stop_lon: "-7.317866",
      parent_station: "",
    });

    expect(stop).toMatchObject({
      stopLat: 54.996629,
      stopLon: -7.317866,
      parentStation: null,
      stopCode: null,
      locationType: null,
    });
  });

  it("rejects a missing required value", () => {
    expect(() =>
      parsers.routes({ route_id: "r", agency_id: "", route_type: "3" }),
    ).toThrow("agency_id: expected a value");
  });

  it("rejects malformed values", () => {
    expect(() =>
      parsers.calendar_dates({
        service_id: "1",
        date: "2026-10-26",
        exception_type: "2",
      }),
    ).toThrow('date: expected YYYYMMDD, got "2026-10-26"');
    expect(() =>
      parsers.stop_times({
        trip_id: "t",
        arrival_time: "7:5:00",
        stop_id: "s",
        stop_sequence: "1",
      }),
    ).toThrow("arrival_time: expected H:MM:SS");
  });
});
