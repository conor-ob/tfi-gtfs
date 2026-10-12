# Serve the Schedule from a SQLite file built by the import job

Supersedes [0003](0003-schedule-import-schema-swap.md), and the "writes directly to Postgres" half of [0002](0002-schedule-import-job-writes-directly-to-postgres.md).

An always-on Postgres is most of the hosting bill, because Railway bills its RAM and CPU around the clock. Yet the Schedule is read-only between imports and replaced wholesale once a day. So the Schedule Import now builds one SQLite file per Feed Version and uploads it to a Railway Storage Bucket. The server downloads that file and queries it in-process with `node:sqlite`. Postgres is removed.

- **Job**: `schedule-sync` stays a separate cron (the rest of 0002 holds). It runs the same `ScheduleImportService` against a SQLite `ScheduleImportRepository`, writing to local disk. It gzips the file, uploads it as `schedule/v<schemaVersion>/<feedVersion>.sqlite.gz`, then overwrites `schedule/v<schemaVersion>/latest.json` with `{ key, feedVersion, etag, sha256, importedAt }`. Writing the pointer last is the publish step. Readers never see a half-uploaded file, and a failed import leaves the pointer alone. The pointer's `feedVersion` and `etag` replace `public.schedule_import` for change detection.
- **Server**: on startup, and then every few minutes, the server reads the pointer for the schema version its code expects. When the pointer changes, it downloads the file to its ephemeral disk, checks the hash, opens it read-only and swaps the handle behind the repositories. It then deletes the previous file. `node:sqlite` is synchronous, so no query is in flight across the swap. The server needs no volume. A fresh container downloads the current file (about 26 MB) before it reports healthy.
- **Layout**: the file uses integer IDs for Trips, Stops, Routes and Services. `stop_times` is a `WITHOUT ROWID` table keyed on `(stop, departure_time, trip, stop_sequence)` and holds only the columns Departures read. GTFS IDs stay as unique text columns on their own tables. The job may load in GTFS-shaped text tables and derive this layout from them, as the spike does. Integrity checks run on the text tables.
- **Schema versions**: the schema version is part of the bucket path. This lets a deploy that changes the layout ship before the job writes files in the new layout, and an older server keeps reading files in the layout it understands. A new schema version needs one manual job run after deploy.

## Considered Options

- **Keep Postgres**: everything already works, and it has SQL, migrations and an atomic schema swap. It is rejected on cost alone.
- **Redis**: Redis holds the whole Schedule in RAM, which is the cost we are trying to avoid. It also turns the calendar joins into application code.
- **Import inside the server, writing to its volume**: this has the fewest moving parts, but the import's roughly 170 MB peak competes with requests in one container. That is the reason 0002 put the import in a separate job. A Railway volume attaches to only one service, so the job can't write to the server's volume.
- **Bake the file into the server image** (build it in scheduled CI): no runtime storage is needed, but there is a full redeploy every day.
- **GTFS-shaped text layout**: the spike's layout A. It is simplest to query, but the file is 519 MB (111 MB gzipped), and the two `stop_times` indexes alone take 254 MB.

## Consequences

- Spike (`jobs/schedule-sync/scripts/spike-sqlite.ts`, Feed Version of 2026-10-12, 5.8M Stop Times):
  - The integer-ID layout is 113 MB, or 26 MB gzipped.
  - Departures at the busiest Stop take 0.08 ms at p50 and 0.14 ms at p99. Nearby Stops take 0.07 ms at p50. Both were measured with a warm OS cache.
  - The import takes 84 s with a 172 MB peak RSS, plus 4.6 s to derive the integer layout. It is slower than Postgres `COPY` (about 30 s), which is acceptable for a daily job.
- The spike's RSS rose to 494 MB after the build, while it measured sizes and ran benchmarks. The cause must be found before the server opens files the same way.
- The server's memory includes the page cache over a file of about 100 MB, far less than Postgres's 768 MB cap.
- Drizzle migrations and the CI migration checks go away. The build code owns the schema. Repository tests run against a file built from a fixture feed, so CI no longer needs a Postgres service. Local development no longer needs `pnpm db:up`.
- Rollback means pointing `latest.json` at an older key. The job keeps the last seven files per schema version and deletes older ones.
- Bucket storage is $0.015 per GB-month, and downloads to services are free. Uploads from the job are billed as egress, at roughly 26 MB a day.
- Nothing durable is left in a database. If user-owned data arrives later, it needs a home again, either a SQLite file on a volume or a small Postgres. It must not reference Schedule IDs in a way that breaks when the Schedule is replaced.
- 0004 (streaming zip entries) and 0005 (Realtime in server memory) are unaffected. The server stays at one replica.
