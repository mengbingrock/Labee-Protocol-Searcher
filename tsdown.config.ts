import { defineConfig } from "tsdown";

// Bundle the MCP server into a single ESM file with a node shebang so the chat
// route (and any MCP client) can spawn it directly with `node dist/index.mjs`.
// `unpdf` (pdf.js) is kept external and resolved from node_modules at runtime —
// it's large, only needed for the PDF-extraction path, and imported lazily.
const shared = {
  format: "esm" as const,
  platform: "node" as const,
  target: "node20",
  clean: true,
  dts: false,
  external: ["unpdf"],
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    outDir: "dist",
  },
  {
    ...shared,
    entry: { "labee-protocol-searcher": "src/index.ts" },
    outDir: "plugins/labee-protocol-searcher/scripts",
    // The plugin must start offline. Bundle the residential agent's only
    // runtime package instead of asking npm/npx to resolve it at launch.
    noExternal: ["ws"],
    inlineOnly: ["ws"],
  },
]);
