import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  platform: "node",
  format: "esm",
  deps: {
    // Workspace packages export TypeScript source, which the Docker image
    // deletes, so bundle them along with their dependencies. The job's own
    // npm dependencies stay external
    alwaysBundle: [/^@tfi-gtfs\//],
    onlyBundle: false,
  },
  // tfi-gtfs-sqlite reads the Schedule's schema from beside its module, which
  // is the bundle once inlined
  copy: ["../../packages/tfi-gtfs-sqlite/src/schema.sql"],
});
