// Every kept Agency publishes its Schedule in this time zone
const TIME_ZONE = "Europe/Dublin";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const localDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const localDateTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** The local calendar date of an instant, as `YYYY-MM-DD` */
export function localDateOf(instant: Date): string {
  return localDate.format(instant);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The instant a Service Day's Stop Times count from. GTFS measures them from
 * noon minus 12 hours, which is midnight except on days the clocks change.
 */
export function serviceDayStart(serviceDate: string): Date {
  const noonUtc = Date.parse(`${serviceDate}T12:00:00Z`);
  // Dublin's clocks change at 01:00 UTC, so the offset at 12:00 UTC is the
  // offset at local noon
  const noon = noonUtc - offsetMs(new Date(noonUtc));
  return new Date(noon - 12 * HOUR_MS);
}

/** Local wall-clock time minus UTC at an instant */
function offsetMs(instant: Date): number {
  const parts = Object.fromEntries(
    localDateTime.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const wallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wallClock - Math.floor(instant.getTime() / 1000) * 1000;
}
