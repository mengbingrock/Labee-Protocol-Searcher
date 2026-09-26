import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VENDOR_IDS } from "../src/vendors.ts";
import { runHttpServer } from "../src/http.ts";

const skillsRoot = new URL(
  "../plugins/labee-protocol-searcher/skills/",
  import.meta.url,
);
const pluginRoot = new URL("../plugins/labee-protocol-searcher/", import.meta.url);
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "plugin-test", version: "1" },
  },
});
const LIST_TOOLS = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const AUTH_STATUS = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "labee_auth", arguments: { action: "status" } },
});

describe("Codex plugin source selectors", () => {
  it("uses the bundled proxy without an npm startup dependency", () => {
    const manifest = JSON.parse(
      readFileSync(new URL(".mcp.json", pluginRoot), "utf8"),
    ) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const server = manifest.mcpServers["labee-protocol-searcher"];

    expect(server).toEqual({
      type: "stdio",
      command: "node",
      args: ["scripts/labee-protocol-searcher.mjs"],
      cwd: ".",
      env_vars: [
        "MCP_BEARER_TOKEN",
        "PROTOCOLS_REMOTE_MCP_URL",
        "PROTOCOLS_REMOTE_MCP_TOKEN",
        "PROTOCOLS_REMOTE_MCP_TIMEOUT_MS",
        "LABEE_OAUTH_FILE",
        "LABEE_LOCAL_CONFIG",
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
      ],
    });
    expect(readFileSync(new URL("scripts/labee-protocol-searcher.mjs", pluginRoot), "utf8"))
      .not.toContain("@mengbingrock/labee-protocol-searcher");
    expect(readFileSync(new URL("scripts/labee-protocol-searcher.mjs", pluginRoot), "utf8"))
      .not.toMatch(/from\s+["']ws["']/);
  });

  it("runs the bundled proxy with the configured bearer-token environment", async () => {
    const token = "plugin-proxy-token";
    const server = await runHttpServer(0, "127.0.0.1", { token });
    const child = spawn(process.execPath, ["scripts/labee-protocol-searcher.mjs"], {
      cwd: fileURLToPath(pluginRoot),
      env: {
        ...process.env,
        MCP_BEARER_TOKEN: token,
        PROTOCOLS_REMOTE_MCP_URL: `http://127.0.0.1:${server.port}/mcp`,
        PROTOCOLS_REMOTE_MCP_TIMEOUT_MS: "2000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(`${INIT}\n${LIST_TOOLS}\n${AUTH_STATUS}\n`);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("bundled plugin proxy timed out"));
      }, 5_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    await server.close();

    expect(exitCode).toBe(0);
    expect(stderr).toContain("stdio proxy ready");
    const responses = stdout.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      id: number;
      result: { serverInfo?: { name: string }; tools?: Array<{ name: string }>; structuredContent?: { authenticated: boolean } };
    }>;
    const byId = new Map(responses.map((response) => [response.id, response]));
    expect(byId.get(1)?.result.serverInfo?.name).toBe("labee-protocol-searcher");
    expect(byId.get(2)?.result.tools?.some((tool) => tool.name === "labee_auth")).toBe(true);
    expect(byId.get(3)?.result.structuredContent?.authenticated).toBe(false);
  }, 10_000);

  it("exposes one toggleable skill for every searchable source", () => {
    const expected = [...VENDOR_IDS, "rebase"].sort();
    const actual = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("labee-source-"))
      .map((entry) => entry.name.slice("labee-source-".length))
      .sort();

    expect(actual).toEqual(expected);
  });

  it.each([...VENDOR_IDS, "rebase"])("declares the %s source id and UI metadata", (source) => {
    const root = new URL(`labee-source-${source}/`, skillsRoot);
    const skill = readFileSync(new URL("SKILL.md", root), "utf8");
    const metadata = readFileSync(new URL("agents/openai.yaml", root), "utf8");

    expect(skill).toContain(`source id \`${source}\``);
    expect(skill).toContain(`Contribute \`${source}\``);
    expect(metadata).toContain("display_name:");
    expect(metadata).toContain("short_description:");
  });
});
