# Trip Updates cached in Redis, refreshed on read

Supersedes [0005](0005-realtime-polled-on-demand-in-server-memory.md).

The demand-gated poller is replaced by stale-while-revalidate on read. Each request for Departures tries to claim a 60-second refresh cooldown (`SET NX PX` in Redis). The request that wins it fetches the Realtime Feed in the background, while every other request reads whatever snapshot is there. Only on a cold start, with no snapshot at all, does the winning request wait for the fetch (up to about 2 s). Trip Updates are stored per Trip in a Redis hash, so a request reads only the Trips its Departures need (`HMGET`) instead of the whole ~560 KB feed. This is mainly an experiment in running Redis. It also means the first request after an idle spell gets Predicted Departures, and it removes the poller's timer and demand tracking.

## Considered Options

- **Keep the poller and swap only the store**: the smallest change, but it tests nothing new and keeps the cold start.
- **Read-through with a hard 60 s TTL**: simpler, but when the key expires every concurrent request fetches at once, and a single failed fetch leaves no Trip Updates until the next one works.
- **One blob per snapshot**: each request would GET and decode the whole feed, so Redis would just be a slower copy of the in-memory Map.
- **In-process single-flight instead of the Redis cooldown**: fine on one replica, but the cooldown key also acts as the rate limiter and retry timer, and it holds across replicas.

## Consequences

- At most one Realtime Feed read per 60 s, measured from when the fetch starts. A failed fetch is retried once the cooldown lapses. No demand means no fetches.
- A snapshot expires in Redis at the feed's timestamp + 5 minutes (`PXAT`/`PEXPIREAT`), so an empty read means no Trip Updates and nothing checks its age on read. A new snapshot replaces the old one (`DEL`, `HSET`) inside one `MULTI`, and reads are one `MULTI` too, so readers never see half of one.
- The `TripUpdateStore` port becomes `getTripUpdates(keys)`, `replace(feed, expiresAt)` and `claimRefresh(cooldownMs)`, and the policy stays in core. `TRIP_UPDATE_STORE=memory|redis` picks the adapter. The in-memory store (the default) runs the same policy.
- `DepartureService` always queries the hour of look-back, then drops those rows when there are no Trip Updates, because it only knows which Trips to look up after querying the Schedule.
- Redis errors and timeouts are logged and treated as "no Trip Updates", so Departures never fail because of Redis.
- The server can scale past one replica as far as Trip Updates are concerned, but stays at one for now.
- First run (2026-10-12): about 3,400 Trip Updates take about 2.1 MB in Redis. A cold request that waits for the read took about 190 ms locally, and a warm one about 10 ms.
