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

Env vars live in a per-package `.env`; copy each `.env.example`. `NTA_API_KEY` goes in `apps/server/.env`. `pnpm db:reset` wipes the database volume and starts fresh. It uses the default port 5432, so stop any other local Postgres (e.g. putting-pals') first.

## Design notes

Smaller decisions that don't warrant an ADR:

- **Feed URLs**: Schedule `https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip`; Realtime `https://api.nationaltransport.ie/gtfsr/v2/TripUpdates` with an `x-api-key` header.
- **Agency filter**: keep `1`, `3`, `03C`, `10000`, `IR` (see ADR 0001). Filtering happens during the import by tracking kept `route_id`s, then kept `trip_id`s; routes and trips stream before `stop_times` because we choose the entry order.
- **Entries imported**: agency, routes, trips, stops, calendar, calendar_dates, stop_times, feed_info. `shapes.txt` (91 MB compressed) and `translations.txt` are skipped for now; keep `trips.shape_id` so shapes can be added later as one more table.
- **Change detection**: skip the import when the zip's ETag and `feed_info.feed_version` match the last successful import (stored in a `public` metadata table).
- **Times**: store Stop Times as integer seconds since the start of the Service Day (GTFS times can exceed `24:00:00`). Service Days are in `Europe/Dublin`. "Next Departures" must check active Service Calendars for both today and yesterday.
- **Nearby stops**: no PostGIS. Bounding box on indexed `stop_lat`/`stop_lon`, then sort by haversine distance in SQL, behind a `findStopsNear` port.
- **Server cache invalidation**: the server learns of a new Feed Version from the database (metadata row or `NOTIFY`), never from the job directly.
- **Realtime overlay**: match Trip Updates to Departures on `trip_id` + `start_date`; apply each Stop Time Update's Delay, and carry the last Delay forward to later Stops. Ignore ADDED trips for now. CANCELED trips and SKIPPED stops remove the Departure.
- **Cron**: `schedule-sync` at `0 4 * * *` (Railway cron is UTC; the Schedule is published around 22:30 UTC).

## Roadmap

1. **Schedule tables**: drizzle schema in the `gtfs` Postgres schema plus first migration; local Postgres for dev.
2. **Schedule Import**: `gtfs-static` row parsers → `tfi-gtfs-db` `COPY` into `gtfs_staging` → checks → schema swap (ADRs 0002–0004). Core owns the import service and its ports.
3. **Departures (scheduled)**: core service + repository query for Scheduled Departures at a Stop; tRPC procedure.
4. **Nearby stops**: core service + repository query; tRPC procedure.
5. **Realtime**: `gtfs-realtime` client, in-memory Trip Update snapshot behind a port, on-demand poller in the server (ADR 0005), Predicted Departures overlay.
6. **Deploy**: `.railway/railway.ts` with server, Postgres and the `schedule-sync` cron; `NTA_API_KEY` as a sealed variable.

## Spikes

- `pnpm --filter @tfi-gtfs/gtfs-static spike [--slow]`: streams the whole Schedule zip and reports entry order, row counts per Agency, timing and peak memory.
- `pnpm --filter @tfi-gtfs/gtfs-realtime spike`: one TripUpdates request; reports feed shape and how Trip Updates join to static `trip_id`s.
