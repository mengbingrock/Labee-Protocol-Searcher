import { defineConfig } from "tsdown";

// Bundle the MCP server into a single self-contained ESM file with a node
// shebang so the chat route (and any MCP client) can spawn it directly with
// `node dist/index.mjs`. It has no runtime npm deps — only Node builtins — so
// nothing needs to stay external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  outDir: "dist",
  platform: "node",
  target: "node20",
  clean: true,
  dts: false,
});
