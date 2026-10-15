import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  parseSchedulePointer,
  type ScheduleObjectBody,
  type SchedulePointer,
  type ScheduleStore,
  type ScheduleStoreObject,
  schedulePointerKey,
} from "@tfi-gtfs/tfi-gtfs-core";

const TEMP_SUFFIX = ".tmp";

/**
 * A folder with the bucket's key layout, for local development and CI. Every
 * write goes to a temp file that is renamed into place, so readers see the
 * old object or the new one. A folder has no ETags, so the object's sha256
 * stands in.
 */
export class FsScheduleStore implements ScheduleStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async getPointer(schemaVersion: number): Promise<SchedulePointer | null> {
    try {
      const json = await readFile(
        this.pathOf(schedulePointerKey(schemaVersion)),
        "utf8",
      );
      return parseSchedulePointer(json);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getObject(key: string): Promise<AsyncIterable<Uint8Array>> {
    const file = this.pathOf(key);
    // Fails now for a missing object, rather than on the first read
    await stat(file);
    return createReadStream(file);
  }

  async put(key: string, body: ScheduleObjectBody): Promise<{ etag: string }> {
    const file = this.pathOf(key);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}${TEMP_SUFFIX}`;
    const hash = createHash("sha256");
    const chunks = typeof body === "string" ? [Buffer.from(body)] : body;
    const handle = await open(temp, "w");
    try {
      for await (const chunk of chunks) {
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      await rename(temp, file);
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(temp, { force: true });
      throw error;
    }
    return { etag: hash.digest("hex") };
  }

  async list(prefix: string): Promise<ScheduleStoreObject[]> {
    let names: string[];
    try {
      names = await readdir(this.root, { recursive: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const objects: ScheduleStoreObject[] = [];
    for (const name of names) {
      const key = name.split(path.sep).join("/");
      if (!key.startsWith(prefix) || key.endsWith(TEMP_SUFFIX)) continue;
      const stats = await stat(path.join(this.root, name));
      if (stats.isFile()) objects.push({ key, lastModified: stats.mtime });
    }
    return objects;
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) await rm(this.pathOf(key), { force: true });
  }

  /** Keys are relative paths that must stay inside the folder */
  private pathOf(key: string): string {
    const file = path.resolve(this.root, ...key.split("/"));
    if (!file.startsWith(this.root + path.sep)) {
      throw new Error(`Key is outside the Schedule folder: ${key}`);
    }
    return file;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
