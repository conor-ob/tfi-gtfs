# Schedule Import swaps a whole Postgres schema


All Schedule tables live in a `gtfs` Postgres schema. A Schedule Import loads into a fresh `gtfs_staging` schema, created with `CREATE TABLE … (LIKE gtfs.x INCLUDING ALL)`, checks it, then renames `gtfs` → `gtfs_old` and `gtfs_staging` → `gtfs` in one transaction and drops `gtfs_old`. Readers never see a half-loaded Schedule, and staging always matches the current migrations without restating DDL.

## Considered Options

- **Versioned rows** (`feed_version_id` on every table plus an active pointer): allows rollback and keeping old versions, but every query needs the filter. Not needed while we only ever serve the latest Schedule.
- **Truncate and reload in one transaction**: blocks or stalls reads for the whole load.

## Consequences

- Tables outside `gtfs` (sync metadata, anything user-owned) must never hold foreign keys into `gtfs`, or the swap fails.
- Only the latest Feed Version is kept; there is no rollback beyond re-running an import.
