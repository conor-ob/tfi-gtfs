# Railway Storage Buckets with our IaC and services

Research for [#49](https://github.com/conor-ob/tfi-gtfs/issues/49) (map [#47](https://github.com/conor-ob/tfi-gtfs/issues/47)). Checked 2026-10-15 against `railway` SDK 3.13.1 (installed), Railway CLI 5.67.1, the Railway docs and changelog, and the Railway CLI source.

## Summary

- `.railway/railway.ts` can declare a bucket today with `bucket(name, { region })` from `railway/iac`. Valid regions are `sjc`, `iad`, `ams`, `sin`; use **`ams`** (EU West, Amsterdam), next to our `europe-west4` services. The region can't be changed after creation.
- A bucket has no typed `.env` accessor, but `ref(bucket, "ENDPOINT")` compiles to the Railway reference `${{<bucket name>.ENDPOINT}}`. So `schedule-sync` and `server` get `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION` and `ENDPOINT` as declared variable references, with no secrets in source and no `preserve()`.
- It is S3-compatible (Tigris underneath, endpoint `https://t3.storageapi.dev`). It supports Put/Get/Head/Delete, List V2, Copy, multipart and presigned URLs, so `@aws-sdk/client-s3` works. Versioning, lifecycle rules and object lock are not supported, so the job's "keep 7 files" pruning stays in code.
- ADR 0006's cost figures still hold: $0.015/GB-month storage, free and unlimited API operations, and free bucket egress (the server's downloads). The job's uploads are billed as service egress at $0.05/GB, about 0.8 GB a month or roughly $0.04.
- New since 0006: the bucket is **public network only**, there is no private networking, and each environment gets its own bucket instance and credentials.
- No documented size limit is anywhere near our 26 MB object. A same-region overwrite of `latest.json` is read-after-write consistent.
- Local development: MinIO's community repo is archived and unmaintained (April 2026). It's still S3-compatible, but pick the local stand-in deliberately in the local-bucket ticket.

## 1. Declaring a bucket in `railway.ts`

The installed SDK exports `bucket` from `railway/iac` (`node_modules/railway/dist/index-*.d.ts`):

```ts
type BucketRegion = "sjc" | "iad" | "ams" | "sin";
type BucketConfig = { region?: BucketRegion | null; isDeleted?: boolean | null; isCreated?: boolean | null };
declare function bucket(name: string, config?: BucketConfig): BucketNode;
declare function ref(resource: ResourceNode, output: string): VariableValue;
```

- A `BucketNode` is a `ResourceNode`, so it can go in `group(...)` and `project({ resources })` like the volume does today.
- Region labels come from the CLI source ([`src/controllers/regions.rs`](https://github.com/railwayapp/cli/blob/master/src/controllers/regions.rs)): `ams` is "EU West, Amsterdam" (NL). Bucket regions use their own codes, not the service region IDs such as `europe-west4-drams3a`.
- Region changes are rejected: "Bucket regions are immutable after creation" (SDK README, [IaC reference](https://docs.railway.com/infrastructure-as-code/reference)). Moving a bucket means create, copy, repoint, delete.
- Removing the bucket from the file plans a delete, and `apply` needs `--confirm-destructive` in non-interactive sessions (SDK README). A deleted bucket can be restored for 52 hours ([Storage Buckets](https://docs.railway.com/storage-buckets)).
- The SDK README marks IaC as **experimental/beta**. Its bucket support is minimal: `region` only, and no typed outputs.

## 2. How the job and the server get credentials and endpoint

Railway exposes these variables on a bucket for other services to reference ([Storage Buckets](https://docs.railway.com/storage-buckets)):

| Variable | Meaning |
|---|---|
| `BUCKET` | Globally unique S3 bucket name (display name plus a short hash). Use this for the S3 API, **not** `RAILWAY_BUCKET_NAME`. |
| `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` | S3 credentials |
| `REGION` | e.g. `auto` |
| `ENDPOINT` | S3 endpoint (`https://t3.storageapi.dev`) |

`BucketNode` has no `.env` accessor (only services and databases do), so use `ref()`. In the CLI's IaC compiler ([`src/iac/compiler.rs`](https://github.com/railwayapp/cli/blob/master/src/iac/compiler.rs), `variable_to_config`), a `reference` becomes `${{<resource name>.<output>}}`, and the name is looked up from the graph address (`bucket.schedule` becomes `schedule`). The CLI also records a `variable` edge from the service to the bucket. A sketch:

```ts
const scheduleBucket = bucket("schedule", { region: "ams" });

function bucketEnv(b: BucketNode) {
  return {
    S3_ENDPOINT: ref(b, "ENDPOINT"),
    S3_REGION: ref(b, "REGION"),
    S3_BUCKET: ref(b, "BUCKET"),
    S3_ACCESS_KEY_ID: ref(b, "ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: ref(b, "SECRET_ACCESS_KEY"),
  };
}
// service("server", { env: { ...bucketEnv(scheduleBucket), ... } })
// service("schedule-sync", { env: { ...bucketEnv(scheduleBucket), ... } })
```

Caveats:

- The output names are untyped strings, so a typo only shows up at plan or deploy time.
- This path is confirmed from the SDK types and the CLI source, but has not been run with `railway config plan` against the live project. The first PR should check the plan diff.
- The credentials are referenced, not copied, so they never enter source and don't need `preserve()`. This fits the README's rule that only secrets are `preserve()`d.
- Each environment, including PR environments, gets its own bucket instance with isolated credentials. References resolve per environment.
- The CLI also has `railway bucket create|list|info|credentials|rename`. `credentials` can print `.env` format and rotate keys ([changelog 2026-03-13](https://railway.com/changelog/2026-03-13-highly-available-postgres)).

## 3. S3 compatibility, presigned URLs, local stand-ins

- **Supported** ([Storage Buckets](https://docs.railway.com/storage-buckets)): Put, Get, Head, Delete; ListObjects and ListObjectsV2; Copy; presigned URLs (up to 90 days); object tagging; multipart uploads.
- **Not yet supported**: server-side encryption config (data is encrypted at rest anyway), object versioning, object lock, lifecycle configuration.
  - With no lifecycle rules, "keep the last 7 files" stays a list-and-delete step in the job, as 0006 already says.
  - With no versioning, rollback is "point `latest.json` at an older key", as 0006 says.
- **URL style**: new buckets use virtual-hosted-style URLs. Older buckets may need path-style, and the bucket's Credentials tab says which. With `@aws-sdk/client-s3`, leave `forcePathStyle` false for Railway and make it configurable: MinIO and most local stand-ins need `true`.
- **Region**: the client should use the `REGION` variable (`auto`). The Railway guide's sample hardcodes `us-east-1` ([guide](https://docs.railway.com/guides/storage-buckets-guide)).
- **Backend**: Railway runs buckets on Tigris. Tigris's GetObject supports `If-None-Match` / `If-Match` ([Tigris S3 API](https://www.tigrisdata.com/docs/api/s3/)). So the server can poll `latest.json` with `If-None-Match: <etag>` and get a cheap 304, although operations are free anyway.
- **MinIO locally**: MinIO is S3-compatible, so the same client code works. But `minio/minio` is archived and its README says "THIS REPOSITORY IS NO LONGER MAINTAINED" (GitHub API: `archived: true`, last push 2026-04-24). Official community images stopped in October 2025. Treat the choice of local stand-in as open for the local-bucket ticket; Garage, SeaweedFS and a pinned last MinIO image are candidates.

## 4. Pricing, egress and API limits compared with ADR 0006

| ADR 0006 says | Now ([billing](https://docs.railway.com/storage-buckets/billing), [GA changelog](https://railway.com/changelog/2025-11-28-buckets-ga), [plans](https://docs.railway.com/pricing/plans)) | Changed? |
|---|---|---|
| $0.015 per GB-month | $0.015 per GB-month, averaged daily and **rounded up to the next whole GB-month**, summed across all environments' buckets | Rounding is new detail. 7 × 26 MB is about 0.2 GB, billed as 1 GB-month, or $0.015/month. |
| Downloads to services are free | Bucket egress to the internet or to services is free and unlimited | No |
| Uploads from the job are billed as egress, about 26 MB a day | Uploads from services to buckets are billed at public egress, $0.05/GB | No. About 0.8 GB/month, roughly $0.04. |
| (not stated) | All S3 API operations are free and unlimited | n/a |
| (not stated) | Hobby: up to 50 buckets, 1 TB total. Pro: 100 buckets, unlimited storage. Free: 10 GB. Hard usage limits suspend access. | n/a |
| (not stated) | **Public network only**; buckets aren't on the private network | New. The server and job reach `t3.storageapi.dev` over the internet, so they need outbound HTTPS. Bucket-to-service egress is still free. |

No rate limits are documented by Railway or Tigris.

## 5. Object size limits

- Railway documents none for objects ([billing](https://docs.railway.com/storage-buckets/billing) explicitly lists only storage totals).
- Tigris has said its maximum object size is 5 TB, matching S3. That came from a Tigris representative on the [Fly.io community forum](https://community.fly.io/t/tigris-performance-quotas-and-limits/21943), not from the docs.
- A single PUT of our 26 MB `.sqlite.gz` and a few-hundred-byte `latest.json` are far below any S3-style limit (5 GB single PUT on S3). Multipart is unnecessary.

## 6. Consistency when overwriting `latest.json`

- Railway documents no consistency model.
- Tigris documents ([consistency](https://www.tigrisdata.com/docs/concepts/consistency/)):
  - **Read-after-write is strong in the same region** for every location type, including overwrites and LIST.
  - Cross-region reads are strong for single-region and multi-region buckets.
  - Cross-region reads are only eventual (typically sub-second) for global and dual-region buckets, which may serve a cached copy.
- Railway exposes `REGION=auto` and doesn't say which Tigris location type an `ams` bucket maps to.
- With an `ams` bucket and both services in Amsterdam-adjacent `europe-west4`, reads should be same-region. Even in the worst case, the server sees the new pointer one poll later.
- Pointer-last publishing is still safe, because the data object is written under a new key before the pointer names it.
- Keep the 0006 sha256 check. If the server ever read a stale pointer naming an object that's still present, it would just stay one version behind, never serve a torn file.

## 7. Region availability

- Bucket regions: `sjc` (US West), `iad` (US East), `ams` (EU West, Amsterdam), `sin` (Singapore) (CLI `regions.rs`, SDK `BucketRegion`).
- Our services run in `europe-west4-drams3a` (Netherlands), so **`ams`** is the right choice. Set it at creation, because it is immutable.

## Open points for later tickets

- Run `railway config plan` on the first PR that adds the bucket. It confirms that `ref(bucket, ...)` resolves and shows the bucket create in the diff.
- Choose the local S3 stand-in (MinIO is unmaintained) and set `forcePathStyle` per environment.
- The server's startup download goes over the public internet. Factor that into the startup and health ticket's timeouts.
