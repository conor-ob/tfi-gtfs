import type {
  ScheduleFeed,
  ScheduleFeedClient,
  ScheduleTableName,
  ScheduleTables,
} from "@tfi-gtfs/tfi-gtfs-core";
import { parse } from "csv-parse";
import { type CsvRecord, parsers } from "./parsers";
import { openRemoteZip } from "./remote-zip";

export class GtfsStaticScheduleFeedClient implements ScheduleFeedClient {
  constructor(private readonly url: string) {
    this.url = url;
  }

  async open(): Promise<ScheduleFeed> {
    const zip = await openRemoteZip(this.url);
    return {
      etag: zip.etag,
      read: <T extends ScheduleTableName>(table: T) =>
        readEntry(table, () => zip.openEntry(`${table}.txt`)),
    };
  }
}

async function* readEntry<T extends ScheduleTableName>(
  table: T,
  openEntry: () => Promise<NodeJS.ReadableStream>,
): AsyncIterable<ScheduleTables[T]> {
  const parseRow = parsers[table];
  const records = (await openEntry()).pipe(
    parse({ bom: true, columns: true, trim: true, info: true }),
  );
  for await (const { record, info } of records as AsyncIterable<{
    record: CsvRecord;
    info: { lines: number };
  }>) {
    try {
      yield parseRow(record);
    } catch (error) {
      records.destroy();
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${table}.txt line ${info.lines}: ${reason}`, {
        cause: error,
      });
    }
  }
}
