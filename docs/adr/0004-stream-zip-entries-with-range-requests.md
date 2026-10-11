# Stream Schedule zip entries with HTTP Range requests

The Schedule Import never writes the zip to disk or holds it in memory. It reads the zip's central directory with two small Range requests, then fetches each wanted entry with its own Range request (pinned with `If-Range: <etag>`) and pipes it through `inflateRaw` → CSV parser → `COPY`, all as Node streams so backpressure reaches the socket. We chose this over one sequential stream through a streaming-unzip library because it lets us pick the order entries are loaded in and skip entries we don't use without downloading them.

## Considered Options

- **One sequential stream** (e.g. `unzipper`, `fflate`): works on today's feed (every entry is deflate without data descriptors, and archive order happens to be dependency-friendly), but ties us to the publisher's entry order and downloads every entry, including `shapes.txt`, which is 91 MB of the 140 MB zip.

## Consequences

- Depends on the host honouring `Range` and `If-Range` (confirmed for transportforireland.ie). If the file changes mid-import, `If-Range` returns a full 200 and the import aborts rather than mixing two Feed Versions.
- Spike (`packages/gtfs-static/scripts/spike-zip-stream.ts`): all ten entries parsed in 18 s with peak RSS around 120 MB, and memory stayed flat with an artificially slow consumer.
