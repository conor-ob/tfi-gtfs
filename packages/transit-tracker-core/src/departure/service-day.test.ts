import { describe, expect, it } from "vitest";
import { addDays, localDateOf, serviceDayStart } from "./service-day";

describe("serviceDayStart", () => {
  it("is local midnight in summer time", () => {
    expect(serviceDayStart("2026-07-01")).toEqual(
      new Date("2026-06-30T23:00:00Z"),
    );
  });

  it("is local midnight in winter time", () => {
    expect(serviceDayStart("2026-12-01")).toEqual(
      new Date("2026-12-01T00:00:00Z"),
    );
  });

  it("is noon minus 12 hours when the clocks go back", () => {
    // Local midnight is 23:00 UTC the day before, but noon is 12:00 UTC
    expect(serviceDayStart("2026-10-25")).toEqual(
      new Date("2026-10-25T00:00:00Z"),
    );
  });

  it("is noon minus 12 hours when the clocks go forward", () => {
    // Local midnight is 00:00 UTC, but noon is 11:00 UTC
    expect(serviceDayStart("2027-03-28")).toEqual(
      new Date("2027-03-27T23:00:00Z"),
    );
  });
});

describe("localDateOf", () => {
  it("uses the Dublin date, not the UTC date", () => {
    expect(localDateOf(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
    expect(localDateOf(new Date("2026-12-01T23:30:00Z"))).toBe("2026-12-01");
  });
});

describe("addDays", () => {
  it("crosses month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
