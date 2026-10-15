import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  fetchSchedule,
  type SchedulePointer,
  type ScheduleStore,
} from "@tfi-gtfs/tfi-gtfs-core";
import { openSchedule, type ScheduleDatabase } from "@tfi-gtfs/tfi-gtfs-sqlite";
import type { FastifyBaseLogger } from "fastify";

type OpenFile = { path: string; pointer: SchedulePointer };

export type ScheduleLoaderOptions = {
  store: ScheduleStore;
  schedule: ScheduleDatabase;
  /** The layout this server's queries read, part of the bucket path */
  schemaVersion: number;
  pollIntervalMs: number;
  log: FastifyBaseLogger;
  /** Where downloaded files go; defaults to a temp folder, removed on close */
  dir?: string;
};

/**
 * Keeps the newest published Schedule file open behind `schedule` (see
 * docs/adr/0011). It downloads the file `latest.json` points at to a temp
 * folder, then polls the pointer and swaps in each new file, deleting the
 * one it replaces. A failed download leaves the current file serving.
 */
export class ScheduleLoader {
  private readonly options: ScheduleLoaderOptions;
  private dir: string | null = null;
  private current: OpenFile | null = null;
  // Refreshes run one at a time, so two never download the same file
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ScheduleLoaderOptions) {
    this.options = options;
    this.dir = options.dir ?? null;
  }

  /** True once a Schedule file is open */
  get isOpen(): boolean {
    return this.current !== null;
  }

  get feedVersion(): string | null {
    return this.current?.pointer.feedVersion ?? null;
  }

  /** Loads the current Schedule in the background, then polls for new ones */
  start(): void {
    if (this.timer) return;
    const poll = () =>
      this.refresh().catch((error) =>
        this.options.log.warn(error, "Failed to load the Schedule"),
      );
    void poll();
    this.timer = setInterval(poll, this.options.pollIntervalMs);
    this.timer.unref();
  }

  /**
   * Opens the file the pointer names, if it isn't open already. Resolves to
   * the pointer now serving, or null when none has been published.
   */
  refresh(): Promise<SchedulePointer | null> {
    const next = this.queue.then(() => this.load());
    this.queue = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.queue;
    this.options.schedule.close();
    if (this.current) await rm(this.current.path, { force: true });
    this.current = null;
    if (this.dir && !this.options.dir) {
      await rm(this.dir, { recursive: true, force: true });
      this.dir = null;
    }
  }

  private async load(): Promise<SchedulePointer | null> {
    const { store, schedule, schemaVersion, log } = this.options;
    const pointer = await store.getPointer(schemaVersion);
    if (!pointer) {
      if (!this.current) {
        log.warn(`No Schedule published for schema version ${schemaVersion}`);
      }
      return this.current?.pointer ?? null;
    }
    if (this.isCurrent(pointer)) return pointer;

    // The pointer may have moved again since; serve whichever was fetched
    const fetched = await fetchSchedule(store, schemaVersion);
    if (!fetched || this.isCurrent(fetched.pointer)) {
      return this.current?.pointer ?? null;
    }
    const path = await this.download(fetched.pointer, fetched.body);

    const previous = this.current;
    schedule.swap(openSchedule(path))?.close();
    this.current = { path, pointer: fetched.pointer };
    // A republished Feed Version lands on the same path, which is now the
    // new file
    if (previous && previous.path !== path) {
      await rm(previous.path, { force: true });
    }
    log.info(
      `Serving Schedule ${fetched.pointer.feedVersion}` +
        (previous ? ` (was ${previous.pointer.feedVersion})` : ""),
    );
    return fetched.pointer;
  }

  private isCurrent({ key, sha256 }: SchedulePointer): boolean {
    return (
      this.current?.pointer.key === key &&
      this.current.pointer.sha256 === sha256
    );
  }

  /** Gunzips the object to disk, only renaming it into place once verified */
  private async download(
    pointer: SchedulePointer,
    body: AsyncIterable<Uint8Array>,
  ): Promise<string> {
    this.dir ??= await mkdtemp(join(tmpdir(), "tfi-gtfs-schedule-"));
    const path = join(this.dir, `${pointer.feedVersion}.sqlite`);
    const partial = `${path}.partial`;
    try {
      // The body throws at its end if the hash doesn't match
      await pipeline(
        Readable.from(body),
        createGunzip(),
        createWriteStream(partial),
      );
      await rename(partial, path);
      return path;
    } finally {
      await rm(partial, { force: true });
    }
  }
}
