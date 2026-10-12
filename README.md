# tfi-gtfs

Departures and nearby stops for Dublin public transport, built on the NTA's static GTFS Schedule and GTFS-Realtime feed. Consumed by the owner's own apps over tRPC; plain REST endpoints (e.g. for a home smart display) may follow.

Domain language lives in [CONTEXT.md](CONTEXT.md); architectural decisions in [docs/adr](docs/adr).

## Layout

Turborepo + pnpm monorepo, TypeScript throughout, hexagonal architecture modelled on `conor-ob/putting-pals`.

| Path | Role |
|---|---|
| `apps/server` | Fastify server, composition root, tRPC at `/trpc`, Realtime poller |
| `jobs/schedule-sync` | Daily Railway cron: Schedule Import (own composition root, writes to Postgres directly) |
| `packages/tfi-gtfs-core` | Domain, services, inbound/outbound ports. No I/O |
| `packages/tfi-gtfs-db` | Drizzle schema + migrations, repositories, `COPY` loader and schema swap |
| `packages/tfi-gtfs-trpc` | tRPC router, thin layer over core services |
| `packages/tfi-gtfs-utils` | Shared helpers (env schemas, `assertNever`) |
| `packages/gtfs-static` | Adapter: remote zip → CSV streams (`openRemoteZip`) |
| `packages/gtfs-realtime` | Adapter: NTA GTFS-Realtime client + protobuf decoding |

## Local development

```sh
pnpm install
pnpm db:up        # Postgres 18 in Docker on localhost:5432 (db: tfi-gtfs, tests: tfi-gtfs-test)
pnpm dev
```

`tfi-gtfs-db` tests run against the `tfi-gtfs-test` database, so `pnpm db:up` before `pnpm test`.

Env vars live in a per-package `.env`; copy each `.env.example`. `NTA_API_KEY` goes in `apps/server/.env`. `pnpm db:reset` wipes the database volume and starts fresh. It uses the default port 5432, so stop any other local Postgres (e.g. putting-pals') first.

## Design notes

Smaller decisions that don't warrant an ADR:

- **Feed URLs**: Schedule `https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip`; Realtime `https://api.nationaltransport.ie/gtfsr/v2/TripUpdates` with an `x-api-key` header.
- **Agency filter**: keep `1`, `3`, `03C`, `10000`, `IR` (see ADR 0001). Filtering happens during the import by tracking kept `route_id`s, then kept `trip_id`s; routes and trips are held in memory until `stop_times` has streamed, so only Trips with a kept Stop Time are written, then their Routes and Service Calendars.
- **Watched Stops**: `WATCHED_STOP_IDS` on `schedule-sync` (comma-separated, optional) keeps only those Stops' Stop Times and the Trips serving them (see ADR 0007): 13 MB of `gtfs` tables for 10 Stops instead of 758 MB. Unset keeps every Stop. Unknown IDs are logged, not fatal. Nearby stops then searches Watched Stops only.
- **Entries imported**: agency, routes, trips, stops, calendar, calendar_dates, stop_times, feed_info. `shapes.txt` (91 MB compressed) and `translations.txt` are skipped for now; keep `trips.shape_id` so shapes can be added later as one more table.
- **Change detection**: skip the import when the zip's ETag, `feed_info.feed_version` and the sorted Watched Stops match the last successful import (stored in `public.schedule_import`).
- **Times**: store Stop Times as integer seconds since the start of the Service Day (GTFS times can exceed `24:00:00`). Service Days are in `Europe/Dublin`. "Next Departures" must check active Service Calendars for both today and yesterday.
- **Departures**: `departures.getByStop({ stopId, from?, limit? })` looks 24 hours ahead across yesterday's, today's and tomorrow's Service Days, then merges them. A Service Day starts at noon minus 12 hours (GTFS), which differs from midnight on the two days the clocks change. Stop Times with `pickup_type = 1` (every Trip's last Stop) are not Departures. Today's feed has no parent Stations, so a Stop's Departures don't include its platforms yet.
- **Nearby stops**: no PostGIS. `stops.getNearby({ lat, lon, radius?, limit? })` (radius in metres, default 500, max 2000) filters on a bounding box over the indexed `stop_lat`/`stop_lon`, then trims and sorts by haversine distance in SQL, behind a `findStopsNear` port. Only Stops you can board at (`location_type` 0 or empty) are returned, since a Station has no Departures of its own yet.
- **Server cache invalidation**: the server learns of a new Feed Version from the database (metadata row or `NOTIFY`), never from the job directly.
- **Realtime overlay**: match Trip Updates to Departures on `trip_id` + `start_date`; apply each Stop Time Update's Delay, and carry the last Delay forward to later Stops, falling back to the Trip Update's own Delay before the first one. Ignore ADDED trips for now. CANCELED trips and SKIPPED stops remove the Departure. With Trip Updates, `departures.getByStop` also looks back an hour for late Trips, and orders and filters by Predicted Departure where there is one.
- **Realtime polling**: `RealtimeService` in core polls once a minute (`REALTIME_POLL_INTERVAL_SECONDS`; the NTA doesn't publish its rate limit) while Departures were asked for in the last 10 minutes, and ignores a snapshot more than 5 minutes old. Decoded protobuf messages return defaults (`0`) for missing fields, so the adapter checks a field is present before reading a Delay.
- **Staging load**: staging tables are created `EXCLUDING INDEXES`; primary keys and indexes are copied from the `gtfs` catalog after `COPY`, so duplicates fail the check and loads stay fast. Stops are kept when a kept Trip stops there, plus their parent Stations. A session advisory lock stops two imports overlapping, and the swap uses `lock_timeout = 10s` so it never stalls readers for long.
- **Cron**: `schedule-sync` at `0 4 * * *` (Railway cron is UTC; the Schedule is published around 22:30 UTC).
- **Deploy**: `.railway/railway.ts` declares the server, Postgres (capped at 768 MB, so the page cache each Schedule Import leaves behind is reclaimed rather than billed) with its 5 GB `postgres-volume` (Railway provisions it with the database; declaring it adopts it so resizes go through IaC) and the `schedule-sync` cron in `europe-west4`. The server runs migrations as its pre-deploy command and stays at one replica, since Trip Updates live in its memory. `NTA_API_KEY` is `preserve()`d: set it once in the Railway dashboard and seal it there. `ORIGIN` is optional; CORS allows no browser origins unless it's set. Railway waits for a commit's GitHub checks before deploying it (`checkSuites`).
- **CI**: `ci.yaml` is one job against a Postgres 18 service: biome, typecheck, build, migration checks (journal, no ungenerated changes, `migrate.js` applies to an empty database and re-applies as a no-op), then tests. `railway-plan.yaml` plans PRs that touch `.railway/` and comments the diff; `railway-apply.yaml` applies that pinned plan on merge, so there's no manual trigger. If the environment drifted since the plan (e.g. a dashboard variable edit), the apply is refused and the job passes only when a fresh `railway config plan --detailed-exit-code` finds nothing pending; otherwise it fails, and since services wait for every check, that also holds back the merge commit's deploy (use `railway config apply` locally after a dashboard change). Both use the `RAILWAY_TOKEN` project token secret.

## Roadmap

1. ~~**Schedule tables**~~: done. `gtfs` schema plus `public.schedule_import` for change detection; no foreign keys (see `tfi-gtfs-db` schema comment).
2. ~~**Schedule Import**~~: done. `pnpm --filter @tfi-gtfs/schedule-sync dev` imports the live feed into the local database (about 30 s, 300 MB peak RSS, 5.8M Stop Times; about 24 s with 10 Watched Stops).
3. ~~**Departures (scheduled)**~~: done. `DepartureService` in core, `DepartureRepositoryImpl` in db, `departures.getByStop` over tRPC.
4. ~~**Nearby stops**~~: done. `StopService` in core, `StopRepositoryImpl` in db, `stops.getNearby` over tRPC.
5. ~~**Realtime**~~: done. `NtaRealtimeFeedClient` in `gtfs-realtime`, `InMemoryTripUpdateStore` behind a `TripUpdateStore` port, `RealtimeService` on-demand poller (ADR 0005), `predictedDeparture` on each Departure.
6. ~~**Deploy**~~: done. `.railway/railway.ts` with server, Postgres and the `schedule-sync` cron; `railway config plan` / `apply` from a linked checkout.
7. ~~**CI**~~: done. `ci.yaml`, `railway-plan.yaml` and `railway-apply.yaml` under `.github/workflows`.
8. ~~**Watched Stops**~~: done. `WATCHED_STOP_IDS` on `schedule-sync` (ADR 0007). Next: set it on Railway, then lower the Postgres memory cap once the graph settles.

## Spikes

- `pnpm --filter @tfi-gtfs/gtfs-static spike [--slow]`: streams the whole Schedule zip and reports entry order, row counts per Agency, timing and peak memory.
- `pnpm --filter @tfi-gtfs/gtfs-realtime spike`: one TripUpdates request; reports feed shape and how Trip Updates join to static `trip_id`s.
- `pnpm --filter @tfi-gtfs/schedule-sync spike:sqlite [--keep]`: runs the real Schedule Import into a SQLite file through a `node:sqlite` `ScheduleImportRepository`, derives a compact integer-ID layout from it, and reports file and gzip sizes, peak RSS and query latency for both. `--temp-memory` keeps SQLite temp storage in memory, to compare.
- `pnpm --filter @tfi-gtfs/server spike:sqlite-swap`: the server side of ADR 0006 against a local stand-in for the bucket. Downloads and opens the file built above, queries every Stop, hot-swaps to a second Feed Version under load, and rejects an object whose hash doesn't match.
