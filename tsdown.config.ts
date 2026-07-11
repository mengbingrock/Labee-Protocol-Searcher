import { defineConfig } from "tsdown";

// Bundle the MCP server into a single ESM file with a node shebang so the chat
// route (and any MCP client) can spawn it directly with `node dist/index.mjs`.
// `unpdf` (pdf.js) is kept external and resolved from node_modules at runtime —
// it's large, only needed for the PDF-extraction path, and imported lazily.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  outDir: "dist",
  platform: "node",
  target: "node20",
  clean: true,
  dts: false,
  external: ["unpdf"],
});
