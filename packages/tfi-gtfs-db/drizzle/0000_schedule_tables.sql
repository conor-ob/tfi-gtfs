CREATE SCHEMA "gtfs";
--> statement-breakpoint
CREATE TABLE "gtfs"."agency" (
	"agency_id" text PRIMARY KEY NOT NULL,
	"agency_name" text NOT NULL,
	"agency_url" text NOT NULL,
	"agency_timezone" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gtfs"."calendar_dates" (
	"service_id" text NOT NULL,
	"date" date NOT NULL,
	"exception_type" smallint NOT NULL,
	CONSTRAINT "calendar_dates_service_id_date_pk" PRIMARY KEY("service_id","date")
);
--> statement-breakpoint
CREATE TABLE "gtfs"."calendar" (
	"service_id" text PRIMARY KEY NOT NULL,
	"monday" boolean NOT NULL,
	"tuesday" boolean NOT NULL,
	"wednesday" boolean NOT NULL,
	"thursday" boolean NOT NULL,
	"friday" boolean NOT NULL,
	"saturday" boolean NOT NULL,
	"sunday" boolean NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gtfs"."feed_info" (
	"feed_version" text PRIMARY KEY NOT NULL,
	"feed_publisher_name" text NOT NULL,
	"feed_publisher_url" text NOT NULL,
	"feed_lang" text NOT NULL,
	"feed_start_date" date,
	"feed_end_date" date,
	"feed_contact_email" text
);
--> statement-breakpoint
CREATE TABLE "gtfs"."routes" (
	"route_id" text PRIMARY KEY NOT NULL,
	"agency_id" text NOT NULL,
	"route_short_name" text,
	"route_long_name" text,
	"route_desc" text,
	"route_type" smallint NOT NULL,
	"route_url" text,
	"route_color" text,
	"route_text_color" text
);
--> statement-breakpoint
CREATE TABLE "schedule_import" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "schedule_import_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"feed_version" text NOT NULL,
	"etag" text,
	"imported_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gtfs"."stop_times" (
	"trip_id" text NOT NULL,
	"arrival_time" integer,
	"departure_time" integer,
	"stop_id" text NOT NULL,
	"stop_sequence" integer NOT NULL,
	"stop_headsign" text,
	"pickup_type" smallint,
	"drop_off_type" smallint,
	"timepoint" smallint,
	CONSTRAINT "stop_times_trip_id_stop_sequence_pk" PRIMARY KEY("trip_id","stop_sequence")
);
--> statement-breakpoint
CREATE TABLE "gtfs"."stops" (
	"stop_id" text PRIMARY KEY NOT NULL,
	"stop_code" text,
	"stop_name" text NOT NULL,
	"stop_desc" text,
	"stop_lat" double precision NOT NULL,
	"stop_lon" double precision NOT NULL,
	"zone_id" text,
	"stop_url" text,
	"location_type" smallint,
	"parent_station" text,
	"wheelchair_boarding" smallint
);
--> statement-breakpoint
CREATE TABLE "gtfs"."trips" (
	"trip_id" text PRIMARY KEY NOT NULL,
	"route_id" text NOT NULL,
	"service_id" text NOT NULL,
	"trip_headsign" text,
	"trip_short_name" text,
	"direction_id" smallint,
	"block_id" text,
	"shape_id" text
);
--> statement-breakpoint
CREATE INDEX "calendar_dates_date_idx" ON "gtfs"."calendar_dates" USING btree ("date");--> statement-breakpoint
CREATE INDEX "routes_agency_id_idx" ON "gtfs"."routes" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "schedule_import_imported_at_idx" ON "schedule_import" USING btree ("imported_at");--> statement-breakpoint
CREATE INDEX "stop_times_stop_id_departure_time_idx" ON "gtfs"."stop_times" USING btree ("stop_id","departure_time");--> statement-breakpoint
CREATE INDEX "stops_stop_lat_stop_lon_idx" ON "gtfs"."stops" USING btree ("stop_lat","stop_lon");--> statement-breakpoint
CREATE INDEX "stops_parent_station_idx" ON "gtfs"."stops" USING btree ("parent_station");--> statement-breakpoint
CREATE INDEX "trips_route_id_idx" ON "gtfs"."trips" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "trips_service_id_idx" ON "gtfs"."trips" USING btree ("service_id");