/** biome-ignore-all lint/suspicious/noConsole: spike output */
/**
 * Spike: fetch one NTA TripUpdates snapshot and check it joins to the Schedule.
 *
 * Makes a single request to the Realtime Feed (it is rate limited), decodes the
 * protobuf, then streams routes.txt and trips.txt from the static zip to see
 * how many Trip Updates refer to a trip_id the Schedule knows about.
 *
 * Reads NTA_API_KEY from apps/server/.env.
 *
 * Usage: pnpm --filter @tfi-gtfs/gtfs-realtime spike [realtime-url]
 */
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openRemoteZip } from "@tfi-gtfs/gtfs-static";
import { parse } from "csv-parse";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { z } from "zod";

const { transit_realtime: rt } = GtfsRealtimeBindings;

const REALTIME_URL =
  process.argv[2] ?? "https://api.nationaltransport.ie/gtfsr/v2/TripUpdates";
const SCHEDULE_URL =
  "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip";

const env = z
  .object({
    NTA_API_KEY: z.string().min(1, "Set NTA_API_KEY in apps/server/.env"),
  })
  .parse(process.env);

type Long = { toNumber(): number };
const toNumber = (v: number | Long | null | undefined) =>
  v == null ? undefined : typeof v === "number" ? v : v.toNumber();

const count = (m: Map<string, number>, key: string) =>
  m.set(key, (m.get(key) ?? 0) + 1);
const show = (m: Map<string, number>) =>
  [...m]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");

// --- Realtime Feed ------------------------------------------------------------

const started = performance.now();
const response = await fetch(REALTIME_URL, {
  headers: { "x-api-key": env.NTA_API_KEY, "Cache-Control": "no-cache" },
});
const body = Buffer.from(await response.arrayBuffer());
const ms = performance.now() - started;

console.log(`Realtime:  ${REALTIME_URL}`);
console.log(
  `Status:    ${response.status} in ${ms.toFixed(0)}ms, ${body.length} bytes`,
);
console.log("Headers:");
for (const [name, value] of response.headers) {
  if (name === "set-cookie") continue;
  console.log(`  ${name}: ${value}`);
}
if (!response.ok) {
  console.log(`\nBody: ${body.toString("utf8").slice(0, 500)}`);
  process.exit(1);
}

const feed = rt.FeedMessage.decode(body);
const feedTimestamp = toNumber(feed.header.timestamp) ?? 0;
console.log(
  `\nFeed header: version=${feed.header.gtfsRealtimeVersion} incrementality=${rt.FeedHeader.Incrementality[feed.header.incrementality ?? 0]} timestamp=${new Date(feedTimestamp * 1000).toISOString()} (age ${Math.round(Date.now() / 1000 - feedTimestamp)}s)`,
);

const kinds = new Map<string, number>();
for (const entity of feed.entity) {
  if (entity.tripUpdate) count(kinds, "tripUpdate");
  if (entity.vehicle) count(kinds, "vehicle");
  if (entity.alert) count(kinds, "alert");
  if (entity.isDeleted) count(kinds, "isDeleted");
}
console.log(`Entities:    ${feed.entity.length}  ${show(kinds)}`);

const tripUpdates = feed.entity.flatMap((e) =>
  e.tripUpdate ? [e.tripUpdate] : [],
);
const tripRelationship = new Map<string, number>();
const stopRelationship = new Map<string, number>();
const stopTimeShape = new Map<string, number>();
const tripFields = new Map<string, number>();
let stopTimeUpdates = 0;
for (const tu of tripUpdates) {
  count(
    tripRelationship,
    rt.TripDescriptor.ScheduleRelationship[tu.trip.scheduleRelationship ?? 0] ??
      "?",
  );
  if (tu.trip.tripId) count(tripFields, "tripId");
  if (tu.trip.routeId) count(tripFields, "routeId");
  if (tu.trip.startDate) count(tripFields, "startDate");
  if (tu.trip.startTime) count(tripFields, "startTime");
  if (tu.trip.directionId != null) count(tripFields, "directionId");
  if (tu.vehicle?.id) count(tripFields, "vehicle.id");
  if (tu.delay != null) count(tripFields, "tripUpdate.delay");
  for (const stu of tu.stopTimeUpdate ?? []) {
    stopTimeUpdates++;
    count(
      stopRelationship,
      rt.TripUpdate.StopTimeUpdate.ScheduleRelationship[
        stu.scheduleRelationship ?? 0
      ] ?? "?",
    );
    const event = stu.departure ?? stu.arrival;
    count(
      stopTimeShape,
      [
        stu.arrival ? "arr" : "",
        stu.departure ? "dep" : "",
        event?.delay != null ? "delay" : "",
        toNumber(event?.time) ? "time" : "",
        stu.stopId ? "stopId" : "",
        stu.stopSequence != null ? "seq" : "",
      ]
        .filter(Boolean)
        .join("+") || "empty",
    );
  }
}
console.log(`\nTrip Updates: ${tripUpdates.length}`);
console.log(`  trip.scheduleRelationship: ${show(tripRelationship)}`);
console.log(`  fields present:            ${show(tripFields)}`);
console.log(`Stop Time Updates: ${stopTimeUpdates}`);
console.log(`  scheduleRelationship:      ${show(stopRelationship)}`);
console.log(`  shape:                     ${show(stopTimeShape)}`);

// --- Join to the Schedule -----------------------------------------------------

const zip = await openRemoteZip(SCHEDULE_URL);
console.log(`\nSchedule: ${SCHEDULE_URL} (last modified ${zip.lastModified})`);

async function eachRow(
  name: string,
  onRow: (r: Record<string, string>) => void,
) {
  await pipeline(
    await zip.openEntry(name),
    parse({ bom: true, columns: true, relax_column_count: true }),
    new Writable({
      objectMode: true,
      write(row: Record<string, string>, _enc, done) {
        onRow(row);
        done();
      },
    }),
  );
}

const routeAgency = new Map<string, string>();
await eachRow("routes.txt", (r) =>
  routeAgency.set(r.route_id ?? "", r.agency_id ?? ""),
);
const tripRoute = new Map<string, string>();
await eachRow("trips.txt", (r) =>
  tripRoute.set(r.trip_id ?? "", r.route_id ?? ""),
);

const joined = new Map<string, number>();
const unmatchedSamples: string[] = [];
for (const tu of tripUpdates) {
  const relationship =
    rt.TripDescriptor.ScheduleRelationship[tu.trip.scheduleRelationship ?? 0];
  const tripId = tu.trip.tripId ?? "";
  const route = tripRoute.get(tripId);
  if (route != null) {
    count(joined, `${relationship}:matched:agency=${routeAgency.get(route)}`);
  } else {
    const agency = routeAgency.get(tu.trip.routeId ?? "") ?? "unknownRoute";
    count(joined, `${relationship}:unmatched:agency=${agency}`);
    if (unmatchedSamples.length < 8) {
      unmatchedSamples.push(
        `tripId=${tripId} routeId=${tu.trip.routeId} start=${tu.trip.startDate} ${tu.trip.startTime}`,
      );
    }
  }
}
console.log("Join of Trip Updates to static trip_id:");
for (const [k, v] of [...joined].sort()) console.log(`  ${k.padEnd(40)} ${v}`);
if (unmatchedSamples.length) {
  console.log("Unmatched samples:");
  for (const s of unmatchedSamples) console.log(`  ${s}`);
}
