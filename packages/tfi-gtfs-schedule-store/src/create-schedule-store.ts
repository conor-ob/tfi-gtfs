import { S3Client } from "@aws-sdk/client-s3";
import type { ScheduleStore } from "@tfi-gtfs/tfi-gtfs-core";
import {
  type ScheduleStoreConfig,
  scheduleStoreEnvSchema,
} from "@tfi-gtfs/tfi-gtfs-utils";
import { z } from "zod";
import { FsScheduleStore } from "./fs-schedule-store";
import { S3ScheduleStore } from "./s3-schedule-store";

/**
 * Picks the adapter from `SCHEDULE_STORE` and its variables. Throws, naming
 * each missing or invalid variable, so a misconfigured app fails at startup.
 */
export function createScheduleStore(
  env: Record<string, string | undefined> = process.env,
): ScheduleStore {
  const result = scheduleStoreEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Invalid Schedule store config:\n${z.prettifyError(result.error)}`,
    );
  }
  return scheduleStoreFrom(result.data);
}

function scheduleStoreFrom(config: ScheduleStoreConfig): ScheduleStore {
  switch (config.kind) {
    case "fs":
      return new FsScheduleStore(config.dir);
    case "s3":
      return new S3ScheduleStore(
        new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }),
        config.bucket,
      );
  }
}
