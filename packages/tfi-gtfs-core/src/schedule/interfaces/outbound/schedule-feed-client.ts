import type { ScheduleTableName, ScheduleTables } from "../../domain/types";

export interface ScheduleFeedClient {
  /** Opens the currently published Schedule without downloading it */
  open(): Promise<ScheduleFeed>;
}

export interface ScheduleFeed {
  /** Identifies this copy of the feed; changes whenever the file changes */
  etag: string;
  /** Streams one entry's rows; each call reads the entry afresh */
  read<T extends ScheduleTableName>(table: T): AsyncIterable<ScheduleTables[T]>;
}
