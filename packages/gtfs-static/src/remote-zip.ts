import { pipeline, Readable, Transform } from "node:stream";
import { createInflateRaw } from "node:zlib";

export type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
};

export type RemoteZip = {
  url: string;
  size: number;
  etag: string;
  lastModified: string | null;
  /** Entries in archive order */
  entries: ZipEntry[];
  /** Streams one entry's uncompressed bytes, with backpressure to the socket */
  openEntry(name: string): Promise<Readable>;
};

const LOCAL_HEADER_SIZE = 30;
const EOCD_SIZE = 22;
const MAX_COMMENT_SIZE = 65535;

/**
 * Reads a zip over HTTP without downloading all of it: the central directory
 * comes from two small Range requests, and each entry is fetched on demand.
 * Every request is pinned to the first response's ETag with If-Range, so a
 * file replaced mid-read fails loudly instead of mixing two versions.
 */
export async function openRemoteZip(url: string): Promise<RemoteZip> {
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`HEAD ${url} failed: ${head.status}`);
  const size = Number(head.headers.get("content-length"));
  const etag = head.headers.get("etag");
  if (!etag) throw new Error(`${url} has no ETag; cannot pin range reads`);

  const range = async (start: number, end: number) => {
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}`, "If-Range": etag },
    });
    if (response.status !== 206 || !response.body) {
      throw new Error(
        `Expected 206 for bytes ${start}-${end} of ${url}, got ${response.status}`,
      );
    }
    return response;
  };

  const tailStart = Math.max(0, size - EOCD_SIZE - MAX_COMMENT_SIZE);
  const tail = Buffer.from(
    await (await range(tailStart, size - 1)).arrayBuffer(),
  );
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) throw new Error(`${url} is not a zip (no EOCD)`);
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error("ZIP64 is not supported");

  const cd = Buffer.from(
    await (await range(cdOffset, cdOffset + cdSize - 1)).arrayBuffer(),
  );
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`Bad central directory entry at ${p}`);
    }
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    entries.push({
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localHeaderOffset: cd.readUInt32LE(p + 42),
      name: cd.toString("utf8", p + 46, p + 46 + nameLength),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  entries.sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);

  return {
    url,
    size,
    etag,
    lastModified: head.headers.get("last-modified"),
    entries,
    async openEntry(name) {
      const entry = entries.find((e) => e.name === name);
      if (!entry) throw new Error(`${name} not found in ${url}`);
      if (entry.method !== 0 && entry.method !== 8) {
        throw new Error(`${name} uses unsupported method ${entry.method}`);
      }
      // The local header's extra field can differ from the central
      // directory's, so ask for some slack past the compressed data
      const end = Math.min(
        entry.localHeaderOffset +
          LOCAL_HEADER_SIZE +
          entry.name.length +
          1024 +
          entry.compressedSize,
        size - 1,
      );
      const response = await range(entry.localHeaderOffset, end);
      const source = Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      );
      const data = entryData(entry.compressedSize);
      // pipeline destroys every stage with the error if any of them fails,
      // so consumers of the returned stream see it
      return entry.method === 8
        ? pipeline(source, data, createInflateRaw(), () => {})
        : pipeline(source, data, () => {});
    },
  };
}

/** Skips the local file header, then passes exactly `compressedSize` bytes. */
function entryData(compressedSize: number) {
  let header: Buffer | null = Buffer.alloc(0);
  let remaining = compressedSize;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      let data = chunk;
      if (header) {
        header = Buffer.concat([header, data]);
        if (header.length < LOCAL_HEADER_SIZE) return done();
        const skip =
          LOCAL_HEADER_SIZE + header.readUInt16LE(26) + header.readUInt16LE(28);
        if (header.length < skip) return done();
        data = header.subarray(skip);
        header = null;
      }
      if (remaining > 0) {
        const slice = data.subarray(0, remaining);
        remaining -= slice.length;
        this.push(slice);
      }
      done();
    },
  });
}
