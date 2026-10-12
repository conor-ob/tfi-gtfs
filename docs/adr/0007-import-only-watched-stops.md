# Keep Postgres and import only Watched Stops

Supersedes [0006](0006-schedule-served-from-sqlite-file.md).

Most of what Postgres costs comes from the size of what each Schedule Import writes. The full Schedule is about 750 MB of tables and indexes. Writing it fills the page cache inside the container, and Railway counts that cache as used memory, which is why the 768 MB cap exists. The owner only needs Departures for about ten Stops, so the Schedule Import now takes an optional list of Watched Stops (`WATCHED_STOP_IDS` on `schedule-sync`). It keeps only:

- the Stop Times at those Stops;
- the Trips, Routes and Service Calendars that serve them;
- the Watched Stops themselves, plus their parent Stations.

When the list is unset, every Stop is kept, as before. Postgres, the schema swap (0003) and the separate job (0002) all stay as they are.

## Considered Options

- **SQLite file published to a bucket (0006)**: this removes the database service entirely and keeps every Stop. It needs a five-issue migration (a new adapter, bucket publishing, server download and swap, then a cutover), and would save only a further $1–2 a month once the Schedule is this small.
- **Keep every Stop in Postgres**: needs no change, but every import keeps writing 750 MB.

## Consequences

- Measured locally against the Feed Version of 2026-10-12, with the 10 busiest Stops as the worst case:

  | | Every Stop | 10 busiest Stops |
  |---|---|---|
  | Stop Times | 5.8M | 71k |
  | Trips | 118k | 22k |
  | `gtfs` tables | 758 MB | 13 MB |
  | Import time | about 31 s | 24 s |

- Postgres should settle near its own floor, roughly `shared_buffers` (128 MB) plus its background processes. Lower the 768 MB cap once Railway's memory graph confirms it.
- The import now holds kept Routes and Trips in memory until Stop Times have streamed, so it can drop Trips that serve no kept Stop. That raises the job's peak RSS from 256 MB to 297 MB with every Stop kept. It also drops Trips with no Stop Times when there is no list.
- Nearby Stops only searches Watched Stops, and Departures for any other Stop return not found.
- `schedule_import.watched_stop_ids` records the sorted list each import used. Changing the list re-imports at the next run, even when the feed hasn't changed. To apply it straight away, run the job by hand.
- Unknown IDs, such as a typo or a retired Stop, don't fail the import. The job logs them as a warning, so a retired Stop can't freeze the Schedule.
- The SQLite spikes and their results stay in the repo, in case removing the database service becomes worthwhile later.
