import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgSchema,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Static GTFS tables in their own Postgres schema, which the Schedule Import
// used to swap in atomically (docs/adr/0003). The import now publishes a
// SQLite file instead (docs/adr/0011), so these tables hold the last import
// until the server reads the file and Postgres is removed. There are no
// foreign keys, here or from `public`.
//
// Column names match the GTFS spec. Stop Times are integer seconds since the start of the Service Day, because
// GTFS times can run past 24:00:00.
export const gtfsSchema = pgSchema("gtfs");

export const agencyTable = gtfsSchema.table("agency", {
  agencyId: text("agency_id").primaryKey(),
  agencyName: text("agency_name").notNull(),
  agencyUrl: text("agency_url").notNull(),
  agencyTimezone: text("agency_timezone").notNull(),
});

export const routesTable = gtfsSchema.table(
  "routes",
  {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id").notNull(),
    routeShortName: text("route_short_name"),
    routeLongName: text("route_long_name"),
    routeDesc: text("route_desc"),
    routeType: smallint("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
  },
  (table) => [index("routes_agency_id_idx").on(table.agencyId)],
);

export const tripsTable = gtfsSchema.table(
  "trips",
  {
    tripId: text("trip_id").primaryKey(),
    routeId: text("route_id").notNull(),
    serviceId: text("service_id").notNull(),
    tripHeadsign: text("trip_headsign"),
    tripShortName: text("trip_short_name"),
    directionId: smallint("direction_id"),
    blockId: text("block_id"),
    shapeId: text("shape_id"),
  },
  (table) => [
    index("trips_route_id_idx").on(table.routeId),
    index("trips_service_id_idx").on(table.serviceId),
  ],
);

export const stopsTable = gtfsSchema.table(
  "stops",
  {
    stopId: text("stop_id").primaryKey(),
    stopCode: text("stop_code"),
    stopName: text("stop_name").notNull(),
    stopDesc: text("stop_desc"),
    stopLat: doublePrecision("stop_lat").notNull(),
    stopLon: doublePrecision("stop_lon").notNull(),
    zoneId: text("zone_id"),
    stopUrl: text("stop_url"),
    locationType: smallint("location_type"),
    parentStation: text("parent_station"),
    wheelchairBoarding: smallint("wheelchair_boarding"),
  },
  (table) => [
    // bounding-box prefilter for nearby stops
    index("stops_stop_lat_stop_lon_idx").on(table.stopLat, table.stopLon),
    index("stops_parent_station_idx").on(table.parentStation),
  ],
);

export const calendarTable = gtfsSchema.table("calendar", {
  serviceId: text("service_id").primaryKey(),
  monday: boolean("monday").notNull(),
  tuesday: boolean("tuesday").notNull(),
  wednesday: boolean("wednesday").notNull(),
  thursday: boolean("thursday").notNull(),
  friday: boolean("friday").notNull(),
  saturday: boolean("saturday").notNull(),
  sunday: boolean("sunday").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
});

export const calendarDatesTable = gtfsSchema.table(
  "calendar_dates",
  {
    serviceId: text("service_id").notNull(),
    date: date("date").notNull(),
    exceptionType: smallint("exception_type").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serviceId, table.date] }),
    index("calendar_dates_date_idx").on(table.date),
  ],
);

export const stopTimesTable = gtfsSchema.table(
  "stop_times",
  {
    tripId: text("trip_id").notNull(),
    arrivalTime: integer("arrival_time"),
    departureTime: integer("departure_time"),
    stopId: text("stop_id").notNull(),
    stopSequence: integer("stop_sequence").notNull(),
    stopHeadsign: text("stop_headsign"),
    pickupType: smallint("pickup_type"),
    dropOffType: smallint("drop_off_type"),
    timepoint: smallint("timepoint"),
  },
  (table) => [
    primaryKey({ columns: [table.tripId, table.stopSequence] }),
    // Departures at a Stop, in time order
    index("stop_times_stop_id_departure_time_idx").on(
      table.stopId,
      table.departureTime,
    ),
  ],
);

export const feedInfoTable = gtfsSchema.table("feed_info", {
  feedVersion: text("feed_version").primaryKey(),
  feedPublisherName: text("feed_publisher_name").notNull(),
  feedPublisherUrl: text("feed_publisher_url").notNull(),
  feedLang: text("feed_lang").notNull(),
  feedStartDate: date("feed_start_date"),
  feedEndDate: date("feed_end_date"),
  feedContactEmail: text("feed_contact_email"),
});

// One row per Schedule Import into Postgres. No longer written: change
// detection reads the bucket's `latest.json` (docs/adr/0011).
export const scheduleImportTable = pgTable(
  "schedule_import",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    feedVersion: text("feed_version").notNull(),
    etag: text("etag"),
    watchedStopIds: text("watched_stop_ids").array(),
    importedAt: timestamp("imported_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("schedule_import_imported_at_idx").on(table.importedAt)],
);
