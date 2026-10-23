import z from "zod";

/** Bucket variables, each mapped from `ref(bucket, ...)` in railway.ts */
const S3_VARIABLES = {
  endpoint: "SCHEDULE_BUCKET_ENDPOINT",
  region: "SCHEDULE_BUCKET_REGION",
  bucket: "SCHEDULE_BUCKET_NAME",
  accessKeyId: "SCHEDULE_BUCKET_ACCESS_KEY_ID",
  secretAccessKey: "SCHEDULE_BUCKET_SECRET_ACCESS_KEY",
} as const;

export type ScheduleStoreConfig =
  | { kind: "fs"; dir: string }
  | {
      kind: "s3";
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

const optional = z.preprocess(
  (val) => (val === "" ? undefined : val),
  z.string().optional(),
);

/** The variables `scheduleStoreEnvSchema` reads, for an app's .env schema */
export const scheduleStoreVariablesSchema = z.object({
  SCHEDULE_STORE: z.enum(["fs", "s3"]).default("fs"),
  SCHEDULE_DIR: optional.default(".schedule/"),
  SCHEDULE_BUCKET_ENDPOINT: optional.pipe(z.url().optional()),
  SCHEDULE_BUCKET_REGION: optional,
  SCHEDULE_BUCKET_NAME: optional,
  SCHEDULE_BUCKET_ACCESS_KEY_ID: optional,
  SCHEDULE_BUCKET_SECRET_ACCESS_KEY: optional,
});

/**
 * Where the Schedule's SQLite files live (see
 * docs/adr/0011-full-schedule-served-from-sqlite-file-in-bucket.md):
 * `SCHEDULE_STORE=fs` (default) uses the folder `SCHEDULE_DIR`, and `s3`
 * needs every bucket variable
 */
export const scheduleStoreEnvSchema = scheduleStoreVariablesSchema.transform(
  (env, ctx): ScheduleStoreConfig => {
    if (env.SCHEDULE_STORE === "fs") {
      return { kind: "fs", dir: env.SCHEDULE_DIR };
    }
    const config = { kind: "s3" } as Record<string, string>;
    for (const [field, name] of Object.entries(S3_VARIABLES)) {
      const value = env[name];
      if (value) {
        config[field] = value;
      } else {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `${name} is required when SCHEDULE_STORE is s3`,
        });
      }
    }
    return config as ScheduleStoreConfig;
  },
);
