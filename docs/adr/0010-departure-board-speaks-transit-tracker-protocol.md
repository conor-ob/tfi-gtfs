# Departure Board speaks the Transit Tracker protocol

The home Departure Board is an Adafruit Matrix Portal S3 with two 64×32 LED panels running the stock [Transit Tracker](https://github.com/EastsideUrbanism/transit-tracker) firmware, unmodified. So the server speaks that firmware's WebSocket protocol (the one [transit-tracker-api](https://github.com/tjhorner/transit-tracker-api) serves) at `/departure-board`, from a `tfi-gtfs-departure-board` inbound adapter over `DepartureService`. We don't write firmware of our own, and we don't run their server, which would be a second copy of our Schedule Import and Realtime overlay. The firmware takes its server URL and schedule string at runtime, so pointing it at us needs no build of our own.

The protocol is small. The board sends `schedule:subscribe` with `routeStopPairs`, `limit`, `listMode` (`sequential` or `nextPerRoute`) and `sortByDeparture`. The server replies with a `schedule` event of `trips` (`routeId`, `routeName`, `routeColor`, `headsign`, `arrivalTime`, `departureTime` in epoch seconds, `isRealtime`), and sends a `heartbeat` every 30 s. The firmware reconnects after 60 s without one.

## Where we differ from transit-tracker-api

`routeStopPairs` is `route,stop[,offset]` pairs joined by `;`. The firmware passes them through without interpreting them, so the meaning is ours:

- **`*` route**: every Route at the Stop. That's what `departures.getByStop` already does, and it doesn't break if the NTA renumbers a Route.
- **`:0` / `:1` direction suffix on the route** (`*:0`, `BRAY-HOWTH-I:0`): filters by `direction_id`. Dalkey's two DART directions share one `stop_id` and one `route_id`, so a pair alone can't say "northbound". NTA `route_id`s contain spaces (`3 59 d a`) but not colons, so the suffix is split at the last `:`.
- **`nextPerRoute` is one row per Stop, Route and direction.** Upstream groups by Route and direction only, so the same Route at two Watched Stops would collapse into one row.
- **Offset is the Walk Time, not a time shift.** The stock server adds the offset to each trip's times and drops what's in the past, so the board counts down to "leave in N min". Ours hides Departures leaving sooner than `-offset` seconds (`from = now + walkTime`), and the times shown are the real departure times. Don't "fix" this to match upstream: the owner chose real times.

## Considered Options

- **Fork the firmware YAML or component**: would allow layout changes and vertical paging, but we'd maintain a firmware build. Still open if the stock layout stops being enough.
- **Own firmware polling a REST endpoint**: full control over every pixel, but also Wi-Fi provisioning, reconnects, the clock and OTA, all ours to write.
- **Kiosk tablet showing `apps/web`**: no server work at all, but it looks like a screen, not a sign.
- **The configurator's REST API** (`/feeds`, `/stops/within/…`, `/stops/{id}/routes`, `/schedule/{pairs}`): deferred. Its map picker can't express our direction suffix, and the board's settings can be set on the LAN through ESPHome's web server instead.

## Consequences

- A Stop missing from the Schedule yields no trips and a logged warning. Since ADR 0011 the Schedule has every Stop, so any Stop can be named, not only Watched Stops. A malformed schedule string closes the socket with an error.
- Each open board asks for Departures every 30 s, like an open web page, so the Realtime Feed is read about once a minute while it's on (ADR 0009).
- Paging through more Departures than fit on the panel isn't supported. If wanted, the planned extension is server-side: push successive pages of the latest list, switched on by a query parameter on the board's `base_url` (e.g. `?pageSeconds=5`), since the firmware's list mode setting only accepts its two built-in values.
