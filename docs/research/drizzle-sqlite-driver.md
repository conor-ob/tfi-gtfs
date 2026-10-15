# Which Drizzle SQLite driver should the job and server use?

Research for [#48](https://github.com/conor-ob/tfi-gtfs/issues/48), part of the map [#47](https://github.com/conor-ob/tfi-gtfs/issues/47). Checked on 2026-10-15 against drizzle-orm 0.45.4 (`latest`) and 1.0.0-rc.4 (`rc`), Node 24 and 26, better-sqlite3 13.0.3 and @libsql/client 0.18.0.

## Recommendation

Use **`node:sqlite`** as the engine in both `schedule-sync` and the server. It is the engine both spikes already measured. It is built into Node, so there is no native dependency to bundle, install or keep in the Docker image.

drizzle-orm 0.45 has no `node:sqlite` driver. Its `drizzle-orm/node-sqlite` driver exists only in the 1.0 pre-releases. So there are two ways to give Drizzle a `node:sqlite` handle:

1. **Now, on 0.45**: put **`drizzle-orm/sqlite-proxy`** over a `node:sqlite` handle. This is a callback of about ten lines. A throwaway check (below) confirmed read-only open, typed row mapping (including `mode: "boolean"`), `.get()` with no row, and a hot swap behind the callback.
2. **Later, on 1.0**: when 1.0 is stable, swap the callback for `drizzle-orm/node-sqlite`. Table definitions in `sqlite-core` and query code are the same for both drivers.

The fallback is **better-sqlite3 13** with `drizzle-orm/better-sqlite3`. It is the most mature Drizzle SQLite path, and v13 ships N-API prebuilds for musl. It costs a native module that tsdown must leave external, and the Docker image must keep it. Reject libsql and `@tursodatabase/database` (see below).

## Comparison

| | `node:sqlite` | better-sqlite3 13 | `@libsql/client` 0.18 |
|---|---|---|---|
| Drizzle 0.45 driver | None; use `sqlite-proxy` [1] | `drizzle-orm/better-sqlite3`, peer `>=7` [1] | `drizzle-orm/libsql`, peer `>=0.10.0` [1] |
| Drizzle 1.0 RC driver | `drizzle-orm/node-sqlite` (since 1.0.0-beta.17) [2][3] | Yes, peer `>=9.3.0` [3] | Yes [3] |
| Read-only open | `new DatabaseSync(path, { readOnly: true })` [4] | `new Database(path, { readonly: true })` [7] | No `readonly` option in the client config [8] |
| Close and reopen mid-process | `db.close()`, then open a new one [4] | `db.close()` | `client.close()`; it is a connection pool [8] |
| Job's raw bulk load on the same driver | Yes: the spike already uses `prepare().run()` | Yes: same sync `prepare().run()` shape | Only via async `execute`/`batch`; the spike would need a rewrite |
| Native code | None (part of Node) | `.node` addon, prebuilt in the package [6] | Rust addon in optional platform packages [9] |
| Alpine (musl) x64 | n/a | `prebuilds/linuxmusl-x64.node` [6] | `@libsql/linux-x64-musl`, an **optional** dependency [9] |
| Status | Node stability 1.2, release candidate [4][5] | Stable, long-standing | Stable |

## Findings

### Drizzle support and roadmap

- drizzle-orm `latest` is 0.45.4 (2026-10-08). Its published package has these SQLite driver entry points: `better-sqlite3`, `bun-sqlite`, `d1`, `durable-sqlite`, `expo-sqlite`, `libsql`, `op-sqlite`, `sql-js` and `sqlite-proxy`. There is no `node-sqlite` [1].
- `drizzle-orm/node-sqlite` was added in v1.0.0-beta.17 [2]. drizzle-kit gained `node:sqlite` support for migrate and Studio in beta.18 [2]. 1.0.0-rc.4 (2026-06-27) ships it, alongside `tursodatabase*` and Effect drivers [3]. 1.0 is still a pre-release; the `rc` dist-tag is 1.0.0-rc.4.
- The feature request [drizzle-orm#2648](https://github.com/drizzle-team/drizzle-orm/issues/2648) is still open. Its latest comment asks for a backport to 0.x after 0.45.3 added a Netlify driver. No backport has been announced.
- In 1.0.0-rc.4, every SQLite driver, `better-sqlite3` and `node-sqlite` included, extends `SQLiteAsyncDatabase`. Queries are awaited even when the driver runs synchronously ("Split SQLite into `async`, `effect` versions (`sync` remains subtype of `async`)") [3]. So the async API that `sqlite-proxy` gives on 0.45 is the shape the 1.0 drivers have anyway.
- The 1.0 `node-sqlite` session calls `stmt.setReturnArrays(...)`, then spreads each object row (`{ ...row }`) [3]. That is an extra small object per row; for Departures queries of tens of rows it is noise.

### `sqlite-proxy` over `node:sqlite` on 0.45

`drizzle-orm/sqlite-proxy` takes `(sql, params, method) => Promise<{ rows }>`. For `all` and `values` the rows are arrays of column values; for `get` it is one array [1]. `StatementSync.setReturnArrays(true)` (added in Node v24.0.0) returns exactly that [4]:

```ts
let handle = new DatabaseSync(path, { readOnly: true });
const db = drizzle(async (sql, params, method) => {
  const stmt = handle.prepare(sql);
  stmt.setReturnArrays(true);
  if (method === "run") { stmt.run(...params); return { rows: [] }; }
  if (method === "get") return { rows: stmt.get(...params) };
  return { rows: stmt.all(...params) };
});
```

A throwaway script against the published 0.45.4 package ran on local Node 26, using a `WITHOUT ROWID` table and a select with `eq`/`gte`/`orderBy`/`limit`. It returned correctly mapped camelCase rows, with `mode: "boolean"` mapped. `.get()` with no match gave `undefined`. A write on the read-only handle failed with "attempt to write a readonly database". After the swap (`handle = new DatabaseSync(v2, { readOnly: true }); old.close()`), the same Drizzle instance returned rows from the new file.

The callback reads `handle` on every call, so the hot swap is just reassigning one variable. No Drizzle object holds the old connection. A cache of prepared statements in the callback (as in `spike-sqlite-swap.ts`) must belong to the handle and be dropped with it.

### Hot swap with a driver that binds the client

`drizzle-orm/node-sqlite` (1.0) and `drizzle-orm/better-sqlite3` both store the client on the instance at construction (`db.$client = client`) [1][3]. To swap, build a new Drizzle instance for the new handle; construction only creates a dialect and a session. Then repoint the repositories, and close the old handle. Statements made with `.prepare()` belong to the old instance and must be re-made. Drizzle has no API to finalize prepared queries ([drizzle-orm#6158](https://github.com/drizzle-team/drizzle-orm/issues/6158), closed with no API added). With `node:sqlite`, `database.close()` ends the connection, and it fails only if called while a statement is executing [4]. The server is single-threaded and the driver is synchronous, so that can't happen between requests. This is what the swap spike showed (0 errors in about 28,000 queries, per ADR 0006).

### The job's bulk load

`spike-sqlite.ts` uses `DatabaseSync.prepare().run()` in batched transactions, with the `journal_mode = OFF`, `synchronous = OFF` and `temp_store = FILE` pragmas. That stays exactly as it is with `node:sqlite`. The job needs Drizzle at most for the `sqlite-core` table definitions (for column names and types), not for executing the load. better-sqlite3 would mean porting the same code to an almost identical API. libsql would mean rewriting it onto an async, pooled client.

### Native builds, tsdown and Docker

- **`node:sqlite`**: it is a builtin (`node:` scheme only [4]), so tsdown leaves it external for `platform: "node"`. There is nothing to install, build or prune. The images run `node:24-alpine`. `node:sqlite` became a release candidate (stability 1.2) in v24.15.0 and v25.7.0 [4][5]. The repo requires `>=24.19.0`, and setting up a `StatementSync` with `setReturnArrays` needs v24.0.0+.
- **better-sqlite3 13**: v13 moved to N-API. It dropped `prebuild-install`, and prebuilt binaries now ship inside the npm package for linux, linuxmusl, darwin and win32 on x64 and arm64 [6]. `gypfile` is `false`, so `pnpm install` on `node:24-alpine` (x64) needs no compiler or `allowBuilds` entry. It loads `prebuilds/<target>.node` relative to its own `lib/` directory [6]. tsdown bundles phantom dependencies that the code uses [10]. The tsdown configs force-bundle `@tfi-gtfs/*` along with what those packages import. So if `@tfi-gtfs/tfi-gtfs-db` imports better-sqlite3, it would be inlined, and the prebuild lookup would break. It would need `deps.neverBundle: ["better-sqlite3"]` [10]. It would also need to be a direct dependency of the app, so `pnpm prune --prod` keeps it reachable from `apps/server` and `jobs/schedule-sync`.
- **libsql**: native binaries come as `optionalDependencies` of `libsql` (`@libsql/linux-x64-musl` and others) [9]. Both Dockerfiles run `pnpm prune --prod --no-optional`, which would remove them. The Dockerfiles would have to change.
- **`@tursodatabase/database`** 0.8.3 has no musl build (only darwin-arm64, linux-x64-gnu, linux-arm64-gnu and win32-x64 optional packages) [9], so it can't run on the Alpine images. It is also still pre-1.0.

### Memory and performance

- The only measurements made on this data are the ADR 0006 spikes, run on `node:sqlite`. Departures took 0.08 ms at p50 and 0.14 ms at p99. Server RSS was about 125 MB with the whole file read. Build peak was 295 MB derive-only with `temp_store = FILE`. Switching drivers would mean measuring again.
- No first-party source benchmarks `node:sqlite` against better-sqlite3. Both are synchronous in-process bindings to a SQLite amalgamation. better-sqlite3 bundles its own SQLite build; `node:sqlite` uses the one compiled into Node. Expect them to be in the same range for indexed point and range reads like these. Nothing found suggests either one would change the measured numbers in a way that matters.
- libsql's client adds a connection pool and Promise-based execution on every query [8]. That is pure overhead for a single-process, read-only file.

## Open points for the ADR

- Moving to drizzle-orm 1.0 touches the Postgres code too: relations v2, the codec system and other changes listed in the rc release notes [3]. It belongs after the Postgres removal, or at a 1.0 stable release, not in the same change as the SQLite adapter.
- With no Drizzle migrations, the DDL for the file is either written by hand next to the `sqlite-core` tables, or generated once from them. That choice is for the schema ticket, not this one.

## Sources

1. drizzle-orm 0.45.4 published package: entry-point directories, `package.json` `peerDependencies`, `better-sqlite3/driver.js`, `sqlite-proxy/driver.d.ts` and `sqlite-proxy/session.js` (`npm pack drizzle-orm@0.45.4`). Releases: <https://github.com/drizzle-team/drizzle-orm/releases>
2. drizzle-orm release notes, v1.0.0-beta.17 ("New SQLite driver `node-sqlite`") and v1.0.0-beta.18 (drizzle-kit `node:sqlite` support): <https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.17>, <https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.18>
3. drizzle-orm 1.0.0-rc.4 published package (`node-sqlite/driver.js`, `node-sqlite/session.js`, `better-sqlite3/driver.js`, `peerDependencies`) and release notes: <https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4>
4. Node.js v24 `node:sqlite` docs (stability, `DatabaseSync` `readOnly` option, `database.close()`, `statement.setReturnArrays()` added v24.0.0): <https://nodejs.org/docs/latest-v24.x/api/sqlite.html>
5. Node.js v26 `node:sqlite` docs (release candidate since v25.7.0): <https://nodejs.org/docs/latest-v26.x/api/sqlite.html>
6. better-sqlite3 v13.0.0 release notes (N-API, prebuilds in the package) and the published 13.0.3 package (`prebuilds/`, `lib/binding.js`, `gypfile: false`): <https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0>
7. better-sqlite3 API docs (`new Database(path, { readonly })`, `close()`): <https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md>
8. @libsql/client 0.18.0 published package, `lib-esm/sqlite3.js` (local-file options and `ConnectionPool`)
9. npm registry metadata: `libsql@0.5.29` and `@tursodatabase/database@0.8.3` `optionalDependencies`
10. tsdown dependency handling (default externals, phantom dependencies bundled when used, `neverBundle`, `alwaysBundle`): <https://github.com/rolldown/tsdown/blob/main/docs/options/dependencies.md>
