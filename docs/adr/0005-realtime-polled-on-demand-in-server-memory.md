# Realtime Feed is polled on demand and held in server memory

> Superseded by [0009](0009-trip-updates-cached-in-redis-refreshed-on-read.md): no poller; Trip Updates are refreshed on read behind a Redis cooldown, and stored per Trip.

The server itself polls the Realtime Feed and keeps only the latest snapshot of Trip Updates in memory, behind a core port. It polls only while Departures have been requested recently and sleeps otherwise. Railway cron can't run more often than every 5 minutes, the NTA API key is rate limited (one poller only), and nothing needs Realtime history, so Redis or a separate worker would add moving parts with no payoff yet.

## Considered Options

- **Redis-backed snapshot**: needed once there are several server replicas or a separate poller process. The snapshot store is a port, so a Redis adapter can replace the in-memory one without touching core.
- **Always-on polling**: always-fresh data, but spends API quota and logs noise when nobody is looking.

## Consequences

- The server runs as a single replica.
- Spike (2026-10-11): one TripUpdates snapshot is a FULL_DATASET of about 560 KB of protobuf (~2,000 Trip Updates, ~12,600 Stop Time Updates), returned in ~200 ms and about 7 s old. Every Stop Time Update carries a Delay; only ~5% also carry an absolute time. No rate-limit headers are returned, so the poll interval must come from the NTA portal's documented limits.
- The first request after an idle spell gets Scheduled Departures only (or waits for one poll) while the poller wakes up.
