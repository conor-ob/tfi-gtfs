-- The Schedule file's layout (docs/adr/0011-full-schedule-served-from-sqlite-file-in-bucket.md).
-- Trips, Stops, Routes and Services have integer IDs; their GTFS IDs are unique
-- text columns on their own tables. Change user_version, and
-- SCHEDULE_SCHEMA_VERSION in schema.ts, whenever this layout changes.

PRAGMA user_version = 1;

-- The one Schedule Import that built this file
CREATE TABLE schedule_import (
  feed_version TEXT NOT NULL,
  etag TEXT,
  imported_at TEXT NOT NULL
);

CREATE TABLE feed_info (
  feed_version TEXT NOT NULL,
  feed_publisher_name TEXT NOT NULL,
  feed_publisher_url TEXT NOT NULL,
  feed_lang TEXT NOT NULL,
  feed_start_date TEXT,
  feed_end_date TEXT,
  feed_contact_email TEXT
);

CREATE TABLE agency (
  agency_id TEXT PRIMARY KEY,
  agency_name TEXT NOT NULL,
  agency_url TEXT NOT NULL,
  agency_timezone TEXT NOT NULL
);

CREATE TABLE routes (
  id INTEGER PRIMARY KEY,
  route_id TEXT NOT NULL UNIQUE,
  agency_id TEXT NOT NULL,
  route_short_name TEXT,
  route_long_name TEXT,
  route_desc TEXT,
  route_type INTEGER NOT NULL,
  route_url TEXT,
  route_color TEXT,
  route_text_color TEXT
);

CREATE TABLE services (
  id INTEGER PRIMARY KEY,
  service_id TEXT NOT NULL UNIQUE
);

-- Dates are ISO YYYY-MM-DD text, so they compare as strings
CREATE TABLE calendar (
  service INTEGER PRIMARY KEY,
  monday INTEGER NOT NULL,
  tuesday INTEGER NOT NULL,
  wednesday INTEGER NOT NULL,
  thursday INTEGER NOT NULL,
  friday INTEGER NOT NULL,
  saturday INTEGER NOT NULL,
  sunday INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);

CREATE TABLE calendar_dates (
  service INTEGER NOT NULL,
  date TEXT NOT NULL,
  exception_type INTEGER NOT NULL,
  PRIMARY KEY (service, date)
) WITHOUT ROWID;

CREATE TABLE trips (
  id INTEGER PRIMARY KEY,
  trip_id TEXT NOT NULL UNIQUE,
  route INTEGER NOT NULL,
  service INTEGER NOT NULL,
  trip_headsign TEXT,
  trip_short_name TEXT,
  direction_id INTEGER,
  block_id TEXT,
  shape_id TEXT
);

-- parent_station stays a GTFS stop_id
CREATE TABLE stops (
  id INTEGER PRIMARY KEY,
  stop_id TEXT NOT NULL UNIQUE,
  stop_code TEXT,
  stop_name TEXT NOT NULL,
  stop_desc TEXT,
  stop_lat REAL NOT NULL,
  stop_lon REAL NOT NULL,
  zone_id TEXT,
  stop_url TEXT,
  location_type INTEGER,
  parent_station TEXT,
  wheelchair_boarding INTEGER
);

CREATE INDEX stops_stop_lat_stop_lon_idx ON stops (stop_lat, stop_lon);

-- Only what Departures read, clustered so one Stop's Departures are one range
-- of the key. Stop Times without a departure_time are left out
CREATE TABLE stop_times (
  stop INTEGER NOT NULL,
  departure_time INTEGER NOT NULL,
  trip INTEGER NOT NULL,
  stop_sequence INTEGER NOT NULL,
  stop_headsign TEXT,
  pickup_type INTEGER,
  PRIMARY KEY (stop, departure_time, trip, stop_sequence)
) WITHOUT ROWID;
