import type {
  ScheduleTableName,
  ScheduleTables,
} from "@tfi-gtfs/tfi-gtfs-core";

/** One CSV row keyed by its header */
export type CsvRecord = Record<string, string | undefined>;

type Parser<T> = (record: CsvRecord) => T;

export const parsers: {
  [T in ScheduleTableName]: Parser<ScheduleTables[T]>;
} = {
  agency: (r) => ({
    agencyId: text(r, "agency_id"),
    agencyName: text(r, "agency_name"),
    agencyUrl: text(r, "agency_url"),
    agencyTimezone: text(r, "agency_timezone"),
  }),
  routes: (r) => ({
    routeId: text(r, "route_id"),
    agencyId: text(r, "agency_id"),
    routeShortName: optional(r, "route_short_name"),
    routeLongName: optional(r, "route_long_name"),
    routeDesc: optional(r, "route_desc"),
    routeType: int(r, "route_type"),
    routeUrl: optional(r, "route_url"),
    routeColor: optional(r, "route_color"),
    routeTextColor: optional(r, "route_text_color"),
  }),
  trips: (r) => ({
    tripId: text(r, "trip_id"),
    routeId: text(r, "route_id"),
    serviceId: text(r, "service_id"),
    tripHeadsign: optional(r, "trip_headsign"),
    tripShortName: optional(r, "trip_short_name"),
    directionId: optionalInt(r, "direction_id"),
    blockId: optional(r, "block_id"),
    shapeId: optional(r, "shape_id"),
  }),
  stops: (r) => ({
    stopId: text(r, "stop_id"),
    stopCode: optional(r, "stop_code"),
    stopName: text(r, "stop_name"),
    stopDesc: optional(r, "stop_desc"),
    stopLat: float(r, "stop_lat"),
    stopLon: float(r, "stop_lon"),
    zoneId: optional(r, "zone_id"),
    stopUrl: optional(r, "stop_url"),
    locationType: optionalInt(r, "location_type"),
    parentStation: optional(r, "parent_station"),
    wheelchairBoarding: optionalInt(r, "wheelchair_boarding"),
  }),
  calendar: (r) => ({
    serviceId: text(r, "service_id"),
    monday: bool(r, "monday"),
    tuesday: bool(r, "tuesday"),
    wednesday: bool(r, "wednesday"),
    thursday: bool(r, "thursday"),
    friday: bool(r, "friday"),
    saturday: bool(r, "saturday"),
    sunday: bool(r, "sunday"),
    startDate: date(r, "start_date"),
    endDate: date(r, "end_date"),
  }),
  calendar_dates: (r) => ({
    serviceId: text(r, "service_id"),
    date: date(r, "date"),
    exceptionType: int(r, "exception_type"),
  }),
  stop_times: (r) => ({
    tripId: text(r, "trip_id"),
    arrivalTime: optionalTime(r, "arrival_time"),
    departureTime: optionalTime(r, "departure_time"),
    stopId: text(r, "stop_id"),
    stopSequence: int(r, "stop_sequence"),
    stopHeadsign: optional(r, "stop_headsign"),
    pickupType: optionalInt(r, "pickup_type"),
    dropOffType: optionalInt(r, "drop_off_type"),
    timepoint: optionalInt(r, "timepoint"),
  }),
  feed_info: (r) => ({
    feedVersion: text(r, "feed_version"),
    feedPublisherName: text(r, "feed_publisher_name"),
    feedPublisherUrl: text(r, "feed_publisher_url"),
    feedLang: text(r, "feed_lang"),
    feedStartDate: optionalDate(r, "feed_start_date"),
    feedEndDate: optionalDate(r, "feed_end_date"),
    feedContactEmail: optional(r, "feed_contact_email"),
  }),
};

export class GtfsParseError extends Error {
  constructor(field: string, value: string | undefined, expected: string) {
    super(`${field}: expected ${expected}, got ${JSON.stringify(value)}`);
    this.name = "GtfsParseError";
  }
}

function optional(r: CsvRecord, field: string): string | null {
  const value = r[field]?.trim();
  return value ? value : null;
}

function text(r: CsvRecord, field: string): string {
  const value = optional(r, field);
  if (value === null) throw new GtfsParseError(field, r[field], "a value");
  return value;
}

function optionalInt(r: CsvRecord, field: string): number | null {
  const value = optional(r, field);
  if (value === null) return null;
  if (!/^-?\d+$/.test(value)) {
    throw new GtfsParseError(field, value, "an integer");
  }
  return Number(value);
}

function int(r: CsvRecord, field: string): number {
  const value = optionalInt(r, field);
  if (value === null) throw new GtfsParseError(field, r[field], "an integer");
  return value;
}

function float(r: CsvRecord, field: string): number {
  const value = Number(text(r, field));
  if (!Number.isFinite(value)) {
    throw new GtfsParseError(field, r[field], "a number");
  }
  return value;
}

function bool(r: CsvRecord, field: string): boolean {
  const value = text(r, field);
  if (value === "1") return true;
  if (value === "0") return false;
  throw new GtfsParseError(field, value, "0 or 1");
}

/** `YYYYMMDD` → ISO `YYYY-MM-DD` */
function optionalDate(r: CsvRecord, field: string): string | null {
  const value = optional(r, field);
  if (value === null) return null;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) throw new GtfsParseError(field, value, "YYYYMMDD");
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function date(r: CsvRecord, field: string): string {
  const value = optionalDate(r, field);
  if (value === null) throw new GtfsParseError(field, r[field], "YYYYMMDD");
  return value;
}

/** `H:MM:SS` → seconds since the start of the Service Day; may pass 24:00:00 */
function optionalTime(r: CsvRecord, field: string): number | null {
  const value = optional(r, field);
  if (value === null) return null;
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(value);
  if (!match) throw new GtfsParseError(field, value, "H:MM:SS");
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
