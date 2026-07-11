// Minimal, dependency-free `.env` loader, run for its side effect on import.
// Import this FIRST (before any module that reads process.env at load time) so
// values are in place. It never overrides a variable already set in the real
// environment — an MCP client's `env` block always wins over a local file.
//
// Two locations are read, in order: the package directory (so a cloned install
// picks up its own `.env` regardless of the client's working directory) and the
// current working directory (for ad-hoc CLI runs).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function applyEnvFile(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return; // no file here — fine.
  }
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue; // never override the real env
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

// `import.meta` resolves to src/ in dev (strip-types) and to dist/ in the built
// bundle; the package root is one level up from either.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

for (const dir of [packageRoot, process.cwd()]) {
  for (const name of [".env", ".env.local"]) applyEnvFile(resolve(dir, name));
}
