/** biome-ignore-all lint/suspicious/noConsole: spike output */
/**
 * Spike: stream the real TFI static GTFS zip without touching disk.
 *
 * 1. Reads the zip's central directory with two small Range requests, to learn
 *    the archive order, sizes and flags of every entry.
 * 2. Streams entries one at a time in an order we choose, each with its own
 *    Range request: fetch body → local header skip → inflateRaw → csv-parse →
 *    counting sink. Every stage is a Node stream, so backpressure flows from
 *    the sink back to the socket.
 * 3. Counts rows per agency so we can size the agency filter.
 *
 * Usage: pnpm --filter @tfi-gtfs/gtfs-static spike [url] [--slow]
 *   --slow  makes the sink artificially slow on stop_times.txt, to check that
 *           memory stays flat when the consumer is slower than the network.
 */
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import { openRemoteZip } from "../src/remote-zip";

const args = process.argv.slice(2);
const FEED_URL =
  args.find((a) => !a.startsWith("--")) ??
  "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip";
const SLOW = args.includes("--slow");

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

let peakRss = 0;
const rssTimer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 50);

type RowHandler = (row: string[], col: Record<string, number>) => void;

async function streamEntry(name: string, onRow?: RowHandler) {
  const started = performance.now();
  let rows = 0;
  let col: Record<string, number> | null = null;
  let header: string[] = [];
  const slowEvery = SLOW && name === "stop_times.txt" ? 5_000 : 0;

  await pipeline(
    await zip.openEntry(name),
    parse({ bom: true, relax_column_count: true }),
    new Writable({
      objectMode: true,
      highWaterMark: 1024,
      write(row: string[], _enc, done) {
        if (!col) {
          header = row;
          col = Object.fromEntries(row.map((name, i) => [name.trim(), i]));
          return done();
        }
        rows++;
        onRow?.(row, col);
        if (slowEvery && rows % slowEvery === 0) setTimeout(done, 20);
        else done();
      },
    }),
  );

  return { rows, header, ms: performance.now() - started };
}

// --- main -------------------------------------------------------------------

const zip = await openRemoteZip(FEED_URL);
const entries = zip.entries;
console.log(`Feed:          ${FEED_URL}`);
console.log(`Size:          ${mb(zip.size)}  etag=${zip.etag}`);
console.log(`Last-Modified: ${zip.lastModified}\n`);

console.log("Archive order (as a sequential stream would see it):");
console.log(
  entries
    .map(
      (e, i) =>
        `  ${String(i + 1).padStart(2)}. ${e.name.padEnd(22)} ${mb(e.compressedSize).padStart(9)} → ${mb(e.size).padStart(9)}  method=${e.method} dataDescriptor=${(e.flags & 0x08) !== 0}`,
    )
    .join("\n"),
);

// Dependency order: lookups first, so stop_times can be attributed to agencies
const priority = ["agency.txt", "routes.txt", "trips.txt"];
const ordered = [
  ...priority.flatMap((n) => entries.filter((e) => e.name === n)),
  ...entries.filter((e) => !priority.includes(e.name)),
];

const agencyNames = new Map<string, string>();
const routeAgency = new Map<string, string>();
const tripAgency = new Map<string, string>();
const rowsByAgency = new Map<string, Map<string, number>>();
const bump = (file: string, agency: string) => {
  const m = rowsByAgency.get(file) ?? new Map<string, number>();
  m.set(agency, (m.get(agency) ?? 0) + 1);
  rowsByAgency.set(file, m);
};

const handlers: Record<string, RowHandler> = {
  "agency.txt": (r, c) =>
    agencyNames.set(r[c.agency_id ?? 0] ?? "", r[c.agency_name ?? 1] ?? ""),
  "routes.txt": (r, c) => {
    const agency = r[c.agency_id ?? -1] ?? "";
    routeAgency.set(r[c.route_id ?? 0] ?? "", agency);
    bump("routes.txt", agency);
  },
  "trips.txt": (r, c) => {
    const agency = routeAgency.get(r[c.route_id ?? 0] ?? "") ?? "?";
    tripAgency.set(r[c.trip_id ?? 2] ?? "", agency);
    bump("trips.txt", agency);
  },
  "stop_times.txt": (r, c) =>
    bump("stop_times.txt", tripAgency.get(r[c.trip_id ?? 0] ?? "") ?? "?"),
};

console.log(
  `\nStreaming entries in dependency order${SLOW ? " (--slow)" : ""}:`,
);
const totalStarted = performance.now();
for (const entry of ordered) {
  const { rows, header, ms } = await streamEntry(
    entry.name,
    handlers[entry.name],
  );
  console.log(
    `  ${entry.name.padEnd(22)} ${String(rows).padStart(10)} rows  ${(ms / 1000).toFixed(1).padStart(6)}s  peakRSS=${mb(peakRss)}\n      columns: ${header.join(",")}`,
  );
}
console.log(
  `\nTotal: ${((performance.now() - totalStarted) / 1000).toFixed(1)}s, peak RSS ${mb(peakRss)}`,
);

console.log("\nAgencies (routes / trips / stop_times):");
const sorted = [...agencyNames].sort(
  (a, b) =>
    (rowsByAgency.get("stop_times.txt")?.get(b[0]) ?? 0) -
    (rowsByAgency.get("stop_times.txt")?.get(a[0]) ?? 0),
);
for (const [id, name] of sorted) {
  const n = (f: string) => String(rowsByAgency.get(f)?.get(id) ?? 0);
  console.log(
    `  ${id.padEnd(6)} ${name.slice(0, 34).padEnd(34)} ${n("routes.txt").padStart(5)} ${n("trips.txt").padStart(8)} ${n("stop_times.txt").padStart(10)}`,
  );
}
const orphans = rowsByAgency.get("stop_times.txt")?.get("?") ?? 0;
if (orphans) console.log(`  stop_times with unknown trip: ${orphans}`);

clearInterval(rssTimer);
