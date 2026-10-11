# Schedule Import runs as its own job and writes directly to Postgres

The Schedule Import runs as a daily Railway cron job (`jobs/schedule-sync`), separate from the server, and writes straight to Postgres with `COPY` instead of calling the server's API as putting-pals jobs do. It moves around ten million rows, which would be slow and fragile over HTTP, and it should not compete for memory and CPU with the process serving requests.

## Consequences

- The job has its own composition root that wires core, `tfi-gtfs-db` and `gtfs-static`; it does not depend on the server or tRPC.
- Bulk loading goes through `pg` directly (`COPY FROM STDIN`); drizzle owns the table definitions and migrations but is not used for the load.
- The server finds out about a new Feed Version from the database, not from the job.
