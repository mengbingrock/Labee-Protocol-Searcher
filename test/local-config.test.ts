import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalResidentialConfig } from "../src/local-config.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local residential config", () => {
  it("loads only allowlisted keys from a private file without overriding env", () => {
    const root = mkdtempSync(join(tmpdir(), "labee-local-config-"));
    roots.push(root);
    const file = join(root, "proxy.env");
    writeFileSync(file, [
      "PROTOCOLS_RESIDENTIAL_PROXY=on",
      "RESIDENTIAL_PROXY_AGENT_TOKEN='secret'",
      "RESIDENTIAL_PROXY_COUNTRY=US",
      "MCP_BEARER_TOKEN=must-not-load",
      "",
    ].join("\n"), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { RESIDENTIAL_PROXY_COUNTRY: "CA" };
    const result = loadLocalResidentialConfig(env, file);
    expect(result.warning).toBeUndefined();
    expect(result.loaded.sort()).toEqual([
      "PROTOCOLS_RESIDENTIAL_PROXY",
      "RESIDENTIAL_PROXY_AGENT_TOKEN",
    ]);
    expect(env.RESIDENTIAL_PROXY_AGENT_TOKEN).toBe("secret");
    expect(env.RESIDENTIAL_PROXY_COUNTRY).toBe("CA");
    expect(env.MCP_BEARER_TOKEN).toBeUndefined();
  });

  it("refuses a config readable by group or others", () => {
    const root = mkdtempSync(join(tmpdir(), "labee-local-config-"));
    roots.push(root);
    const file = join(root, "proxy.env");
    writeFileSync(file, "PROTOCOLS_RESIDENTIAL_PROXY=on\n", { mode: 0o600 });
    chmodSync(file, 0o644);
    const env: NodeJS.ProcessEnv = {};
    const result = loadLocalResidentialConfig(env, file);
    expect(result.warning).toMatch(/0600/);
    expect(env.PROTOCOLS_RESIDENTIAL_PROXY).toBeUndefined();
  });
});
