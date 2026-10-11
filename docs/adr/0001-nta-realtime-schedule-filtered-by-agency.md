# Use the NTA's realtime-matched Schedule, filtered by Agency

The NTA publishes several static GTFS zips. We import `GTFS_Realtime.zip` rather than `GTFS_All.zip` or the per-operator zips, because it is the one whose trip IDs the Realtime Feed refers to; any other Schedule would leave Trip Updates unmatched. We only care about Dublin, so the Schedule Import keeps a configured list of Agencies and drops the rest.

## Consequences

- The kept Agency list is configuration, not code. Agencies we drop still appear in the Realtime Feed and are ignored.
- Kept Agencies: Dublin Bus (`1`), Go-Ahead Ireland (`3`, `03C`), Luas (`10000`) and Irish Rail (`IR`). Bus Éireann (`2`, `WFRD`) is left out for now, even though some of its routes serve Dublin.
- Spike result (Feed Version of 2026-10-10): the kept Agencies hold about 63% of Stop Times. Dublin Bus alone is 47% of the whole feed, so the filter is about scope more than size.
- Confirmed by spike (`packages/gtfs-realtime/scripts/spike-trip-updates.ts`, 2026-10-11): all 1,920 SCHEDULED and CANCELED Trip Updates matched a `trip_id` in this zip, across every Agency including Luas and Irish Rail. The 36 ADDED Trip Updates have no `trip_id` and a `route_id` in a different format (e.g. `2 220 c b`) that matches no static route, so they are ignored for now.
- Irish Rail's own realtime API will be added later as a second Realtime source; this decision covers the Schedule only.
