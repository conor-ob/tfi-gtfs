import { builtinModules } from "node:module";
import * as path from "node:path";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

// Externalize Node built-ins and the job's own installed dependencies, like the
// server's build. Workspace packages export TypeScript source, which the
// Docker image deletes, so they're bundled along with their dependencies.
const external = [
  ...builtinModules,
  ...Object.entries(pkg.dependencies)
    .filter(([, version]) => !version.startsWith("workspace:"))
    .map(([name]) => name),
];

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(import.meta.dirname, "./src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    rolldownOptions: {
      // Lets bundled CommonJS (e.g. pg) require Node built-ins
      platform: "node",
      external: (id) =>
        id.startsWith("node:") ||
        external.some((name) => id === name || id.startsWith(`${name}/`)),
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
});
