# tfi-gtfs

Departures and nearby stops for Dublin public transport, built on the NTA's static GTFS Schedule and GTFS-Realtime feed. Consumed by the owner's own apps over tRPC, and by a Departure Board at home over WebSocket.

Domain language lives in [CONTEXT.md](CONTEXT.md); architectural decisions in [docs/adr](docs/adr).

## Layout

Turborepo + pnpm monorepo, TypeScript throughout, hexagonal architecture.

| Path | Role |
|---|---|
| `apps/server` | Fastify server, composition root, tRPC at `/trpc`, Departure Board WebSocket at `/departure-board` |
| `apps/web` | React + Tailwind page of live Departures at the Watched Stops, served by Caddy |
| `jobs/schedule-sync` | Daily Railway cron: Schedule Import (own composition root, writes to Postgres directly) |
| `packages/tfi-gtfs-core` | Domain, services, inbound/outbound ports. No I/O |
| `packages/tfi-gtfs-db` | Drizzle schema + migrations, repositories, `COPY` loader and schema swap |
| `packages/tfi-gtfs-redis` | Redis adapter: `RedisTripUpdateStore` and the client factory |
| `packages/tfi-gtfs-trpc` | tRPC router, thin layer over core services |
| `packages/tfi-gtfs-departure-board` | Departure Board adapter: Transit Tracker WebSocket messages, `routeStopPairs` parser, Departures to trips |
| `packages/tfi-gtfs-utils` | Shared helpers (env schemas, `assertNever`) |
| `packages/gtfs-static` | Adapter: remote zip → CSV streams (`openRemoteZip`) |
| `packages/gtfs-realtime` | Adapter: NTA GTFS-Realtime client + protobuf decoding |

## Local development

```sh
pnpm install
pnpm db:up        # Postgres 18 on localhost:5432 (db: tfi-gtfs, tests: tfi-gtfs-test) and Redis 8 on 6379 (tests: db 1), in Docker
pnpm dev
```

`tfi-gtfs-db` tests run against the `tfi-gtfs-test` database and `tfi-gtfs-redis` tests against Redis database 1, so `pnpm db:up` before `pnpm test`.

Env vars live in a per-package `.env`; copy each `.env.example`. `NTA_API_KEY` goes in `apps/server/.env`. `apps/web` proxies `/api` to the local server; set `API_PROXY_TARGET=https://<web domain>/api` in `apps/web/.env` to use production instead. `pnpm db:reset` wipes the database volume and starts fresh. It uses the default ports 5432 and 6379, so stop any other local Postgres or Redis first. The server keeps Trip Updates in memory unless `TRIP_UPDATE_STORE=redis` (with `REDIS_URL`) is set in `apps/server/.env`.

## Design notes

Smaller decisions that don't warrant an ADR:

- **Feed URLs**: Schedule `https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip`; Realtime `https://api.nationaltransport.ie/gtfsr/v2/TripUpdates` with an `x-api-key` header.
- **Import filtering**: every Agency is kept (ADR 0008). Routes and Trips are held in memory until `stop_times` has streamed, so only Trips with a kept Stop Time are written, then their Routes, Agencies and Service Calendars.
- **Watched Stops**: `WATCHED_STOP_IDS` on `schedule-sync` (comma-separated, optional; declared in `.railway/railway.ts`) keeps only those Stops' Stop Times and the Trips serving them (see ADR 0007): 13 MB of `gtfs` tables for 10 Stops instead of 758 MB. Unset keeps every Stop in Ireland (roughly 1.2 GB, whose page cache Railway bills as Postgres memory), so production must set it. Unknown IDs are logged, not fatal. Nearby stops then searches Watched Stops only.
- **Entries imported**: agency, routes, trips, stops, calendar, calendar_dates, stop_times, feed_info. `shapes.txt` (91 MB compressed) and `translations.txt` are skipped for now; keep `trips.shape_id` so shapes can be added later as one more table.
- **Change detection**: skip the import when the zip's ETag, `feed_info.feed_version` and the sorted Watched Stops match the last successful import (stored in `public.schedule_import`).
- **Times**: store Stop Times as integer seconds since the start of the Service Day (GTFS times can exceed `24:00:00`). Service Days are in `Europe/Dublin`. "Next Departures" must check active Service Calendars for both today and yesterday.
- **Departures**: `departures.getByStop({ stopId, from?, directionId?, limit? })` looks 24 hours ahead across yesterday's, today's and tomorrow's Service Days, then merges them. `directionId` (0 or 1) filters Trips in SQL, so the limit is filled from that direction alone. A Service Day starts at noon minus 12 hours (GTFS), which differs from midnight on the two days the clocks change. Stop Times with `pickup_type = 1` (every Trip's last Stop) are not Departures. Today's feed has no parent Stations, so a Stop's Departures don't include its platforms yet.
- **Nearby stops**: no PostGIS. `stops.getNearby({ lat, lon, radius?, limit? })` (radius in metres, default 500, max 2000) filters on a bounding box over the indexed `stop_lat`/`stop_lon`, then trims and sorts by haversine distance in SQL, behind a `findStopsNear` port. Only Stops you can board at (`location_type` 0 or empty) are returned, since a Station has no Departures of its own yet.
- **Server cache invalidation**: the server learns of a new Feed Version from the database (metadata row or `NOTIFY`), never from the job directly.
- **Realtime overlay**: match Trip Updates to Departures on `trip_id` + `start_date`; apply each Stop Time Update's Delay, and carry the last Delay forward to later Stops, falling back to the Trip Update's own Delay before the first one. Ignore ADDED trips for now. CANCELED trips and SKIPPED stops remove the Departure. `departures.getByStop` always queries the hour before for late Trips (it only knows which Trip Updates to ask for afterwards) and keeps those Departures only when there are Trip Updates; it orders and filters by Predicted Departure where there is one.
- **Realtime refresh**: no poller (ADR 0009). Each Departures request asks the `TripUpdateStore` for just its Trips' Trip Updates and tries to claim a 60-second cooldown (`REALTIME_REFRESH_INTERVAL_SECONDS`; the NTA doesn't publish its rate limit). Whoever claims it reads the Realtime Feed in the background, or waits up to 2 s if there are no Trip Updates at all. A snapshot expires 5 minutes after the feed's timestamp. `TRIP_UPDATE_STORE` picks `memory` (default, one replica) or `redis` (production). Redis commands time out after 500 ms and don't queue while disconnected, and any store error means Scheduled Departures only. Decoded protobuf messages return defaults (`0`) for missing fields, so the adapter checks a field is present before reading a Delay.
- **Staging load**: staging tables are created `EXCLUDING INDEXES`; primary keys and indexes are copied from the `gtfs` catalog after `COPY`, so duplicates fail the check and loads stay fast. Stops are kept when a kept Trip stops there, plus their parent Stations. A session advisory lock stops two imports overlapping, and the swap uses `lock_timeout = 10s` so it never stalls readers for long.
- **Cron**: `schedule-sync` at `0 4 * * *` (Railway cron is UTC; the Schedule is published around 22:30 UTC).
- **Builds**: workspace packages export TypeScript source and are never built on their own. The server and `schedule-sync` are bundled with tsdown, which inlines `@tfi-gtfs/*` packages and their dependencies and leaves only each app's own npm dependencies external (the Docker images delete `src/`). `tsc` is only used for typechecking; in development the server runs with `tsx watch`.
- **Deploy**: `.railway/railway.ts` declares the server, Postgres with its 5 GB `postgres-volume` (Railway provisions it with the database; declaring it adopts it so resizes go through IaC) the `web` service (its domain is added in the dashboard), and the `schedule-sync` cron in `europe-west4`. It also declares a `redis` database for Trip Updates (no volume needed; they're disposable). The server runs migrations as its pre-deploy command and stays at one replica for now. `NTA_API_KEY` is `preserve()`d: set it once in the Railway dashboard and seal it there. Only secrets are `preserve()`d; other variables are declared in `railway.ts`, because a dashboard edit while a `.railway/` PR is open moves the environment, the pinned plan is refused on merge, and the failed check holds back that commit's deploy. `ORIGIN` is optional; CORS allows no browser origins unless it's set. Railway waits for a commit's GitHub checks before deploying it (`checkSuites`).
- **Web**: `apps/web` lists Departures for the stops hardcoded in `App.tsx` (keep them in step with `WATCHED_STOP_IDS`), refetching every 30 seconds, so Trip Updates are refreshed about once a minute while the page is open. Caddy serves the build and proxies `/api/*` to the server over Railway private networking, so the browser never calls the server directly. The page is public, with no auth.
- **Departure Board**: an Adafruit Matrix Portal S3 with two Waveshare RGB-Matrix-P2.5-64x32 panels (about €67), on a 5 V USB-C supply, in a 3D-printed case with 12 M3×8 screws. It runs the stock Transit Tracker firmware, flashed from its web installer, and the server speaks its WebSocket protocol at `/departure-board` (ADR 0010), reached through Caddy at `wss://<web domain>/api/departure-board`. The board's settings are ESPHome entities you set on the LAN (`curl -X POST 'http://<board ip>/text/base_url_config/set?value=<url-encoded>'`, and the same for `schedule_config`), with list mode `nextPerRoute`. The schedule string is `route,stop,offset` pairs joined by `;`: `*` for any Route, `:0`/`:1` for a direction, and a negative offset in seconds for the Walk Time. For example, `*:0,8250IR0014,-300;*,8250DB003062,-240` means DART northbound at Dalkey with a 5-minute walk, plus every bus at Breffni Road with a 4-minute walk. The value is limited to 255 characters, and the Stops must be Watched Stops. Caddy's `reverse_proxy` passes the WebSocket upgrade through unchanged, and the rate limit counts only the upgrade request, so an open board isn't throttled. Each board's socket reads up to 50 Departures per pair every 30 s; one that can't be read skips that push but keeps heartbeats going.
- **CI**: `ci.yaml` is one job against Postgres 18 and Redis 8 services: biome, typecheck, build, migration checks (journal, no ungenerated changes, `migrate.mjs` applies to an empty database and re-applies as a no-op), then tests. `railway-plan.yaml` plans PRs that touch `.railway/` and comments the diff; `railway-apply.yaml` applies that pinned plan on merge, so there's no manual trigger (use `railway config apply` locally after a dashboard change). Both use the `RAILWAY_TOKEN` project token secret.

## Roadmap

1. ~~**Schedule tables**~~: done. `gtfs` schema plus `public.schedule_import` for change detection; no foreign keys (see `tfi-gtfs-db` schema comment).
2. ~~**Schedule Import**~~: done. `pnpm --filter @tfi-gtfs/schedule-sync dev` imports the live feed into the local database (about 30 s, 300 MB peak RSS, 5.8M Stop Times; about 24 s with 10 Watched Stops).
3. ~~**Departures (scheduled)**~~: done. `DepartureService` in core, `DepartureRepositoryImpl` in db, `departures.getByStop` over tRPC.
4. ~~**Nearby stops**~~: done. `StopService` in core, `StopRepositoryImpl` in db, `stops.getNearby` over tRPC.
5. ~~**Realtime**~~: done. `NtaRealtimeFeedClient` in `gtfs-realtime`, `InMemoryTripUpdateStore` behind a `TripUpdateStore` port, `RealtimeService` on-demand poller (ADR 0005, since replaced by 0009), `predictedDeparture` on each Departure.
6. ~~**Deploy**~~: done. `.railway/railway.ts` with server, Postgres and the `schedule-sync` cron; `railway config plan` / `apply` from a linked checkout.
7. ~~**CI**~~: done. `ci.yaml`, `railway-plan.yaml` and `railway-apply.yaml` under `.github/workflows`.
8. ~~**Watched Stops**~~: done. `WATCHED_STOP_IDS` on `schedule-sync` (ADR 0007).
9. ~~**Web**~~: done. `apps/web`, a single page of live Departures at the Watched Stops.
10. ~~**Realtime in Redis**~~: done. `RedisTripUpdateStore` in `tfi-gtfs-redis`, refreshed on read instead of polled (ADR 0009).
11. ~~**Departure Board**~~: done. `tfi-gtfs-departure-board` inbound adapter and the `/departure-board` WebSocket route, speaking the Transit Tracker protocol (ADR 0010).

## Spikes

- `pnpm --filter @tfi-gtfs/gtfs-static spike [--slow]`: streams the whole Schedule zip and reports entry order, row counts per Agency, timing and peak memory.
- `pnpm --filter @tfi-gtfs/gtfs-realtime spike`: one TripUpdates request; reports feed shape and how Trip Updates join to static `trip_id`s.
- `pnpm --filter @tfi-gtfs/schedule-sync spike:sqlite [--keep]`: runs the real Schedule Import into a SQLite file through a `node:sqlite` `ScheduleImportRepository`, derives a compact integer-ID layout from it, and reports file and gzip sizes, peak RSS and query latency for both. `--temp-memory` keeps SQLite temp storage in memory, to compare.
- `pnpm --filter @tfi-gtfs/server spike:sqlite-swap`: the server side of ADR 0006 against a local stand-in for the bucket. Downloads and opens the file built above, queries every Stop, hot-swaps to a second Feed Version under load, and rejects an object whose hash doesn't match.
