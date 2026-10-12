# Drop the Agency filter; Watched Stops set the scope

Supersedes the Agency filter in [0001](0001-nta-realtime-schedule-filtered-by-agency.md). The choice of `GTFS_Realtime.zip` stands.

The Schedule Import kept a hardcoded list of Agencies (Dublin Bus, Go-Ahead Ireland, Luas, Irish Rail) so that it would carry Dublin only. Since [0007](0007-import-only-watched-stops.md), Watched Stops set the scope much more tightly. The Agency filter now only matters when a Watched Stop is also served by a dropped Agency, and then it hides real Departures, e.g. Bus Éireann at a Dublin bus stop. So the Schedule Import now keeps every Agency. The Agencies, Routes and Trips it writes are the ones that serve a kept Stop Time.

## Consequences

- A Watched Stop shows Departures from every Agency that serves it.
- With `WATCHED_STOP_IDS` unset, the import keeps the whole of Ireland. The kept Agencies were about 63% of Stop Times (0001), so expect roughly 1.2 GB of `gtfs` tables instead of 0007's 758 MB. That doesn't fit under Postgres' 768 MB cap, so production must set Watched Stops. An unset list is for local runs.
- Agencies that run no kept Route are no longer written.
- The Realtime Feed already matched Trips across every Agency (0001), so Trip Updates for the newly kept Agencies need no extra work.
