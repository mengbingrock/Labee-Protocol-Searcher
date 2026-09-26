import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RESIDENTIAL_KEYS = new Set([
  "PROTOCOLS_RESIDENTIAL_PROXY",
  "RESIDENTIAL_PROXY_CONSENT",
  "RESIDENTIAL_PROXY_AGENT_TOKEN",
  "RESIDENTIAL_PROXY_URL",
  "BROWSERLESS_URL",
  "RESIDENTIAL_PROXY_COUNTRY",
  "RESIDENTIAL_PROXY_REGION",
  "RESIDENTIAL_PROXY_CITY",
  "RESIDENTIAL_PROXY_MAX_CONNECTIONS",
  "RESIDENTIAL_PROXY_ALLOW_HOSTS",
  "RESIDENTIAL_PROXY_READY_TIMEOUT_MS",
  "RESIDENTIAL_PROXY_AGENT_ID",
  "RESIDENTIAL_PROXY_CONTROL_PROXY",
]);

export function defaultLocalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LABEE_LOCAL_CONFIG?.trim()
    || join(homedir(), ".config", "labee", "protocol-searcher.env");
}

/** Load a small, non-shell env file used only for the opt-in local residential
 * bridge. Existing process variables always win. Files readable by group or
 * others are refused because they contain the agent credential. */
export function loadLocalResidentialConfig(
  env: NodeJS.ProcessEnv = process.env,
  file = defaultLocalConfigPath(env),
): { loaded: string[]; warning?: string } {
  let raw: string;
  try {
    const stat = statSync(file);
    if ((stat.mode & 0o077) !== 0) {
      return { loaded: [], warning: `ignored ${file}: permissions must be 0600` };
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return { loaded: [], warning: `ignored ${file}: it is owned by another user` };
    }
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { loaded: [] }
      : { loaded: [], warning: `could not read ${file}` };
  }

  const loaded: string[] = [];
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    if (!RESIDENTIAL_KEYS.has(key) || env[key] != null) continue;
    let value = line.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) value = value.slice(1, -1);
    if (!value || /[\u0000\r\n]/.test(value)) continue;
    env[key] = value;
    loaded.push(key);
  }
  return { loaded };
}
