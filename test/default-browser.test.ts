import { describe, expect, it, vi } from "vitest";
import { DefaultBrowserAdapter } from "../src/agent/default-browser.ts";

const SNAPSHOT = JSON.stringify({
  url: "https://1.1.1.1/protocol",
  title: "NEB protocol",
  text: "Step 1: Mix the reaction and incubate for 30 minutes. ".repeat(20),
  html: "<main><h2>Step 1</h2><p>Mix the reaction and incubate for 30 minutes.</p></main>",
  links: ["https://1.1.1.1/protocol"],
  readyState: "complete",
});

function request() {
  return {
    url: "https://1.1.1.1/protocol",
    sourceId: "neb",
    allowedHosts: ["1.1.1.1"],
    maxChars: 10_000,
    timeoutMs: 1_000,
  };
}

describe("DefaultBrowserAdapter", () => {
  it("uses one dedicated window in the default profile and caches captured HTML", async () => {
    const scripts: string[] = [];
    let open = false;
    const runAppleScript = vi.fn(async (script: string) => {
      scripts.push(script);
      if (script.includes("make new window")) {
        open = true;
        return "731";
      }
      if (script.includes("exists window id 731")) return open ? "true" : "false";
      if (script.includes('javascript "document.title"')) return "";
      if (script.includes("return URL of active tab")) return "about:blank";
      if (script.includes("JSON.stringify")) return SNAPSHOT;
      if (script.includes("close window id 731")) open = false;
      return "";
    });
    const browser = new DefaultBrowserAdapter({
      platform: "darwin",
      runAppleScript,
      sleepImpl: async () => undefined,
    });

    await expect(browser.launch()).resolves.toMatchObject({
      state: "ready",
      profile: "default",
      windowId: 731,
    });
    const hit = await browser.retrieve(request());
    expect(hit).toMatchObject({
      status: "ok",
      html: expect.stringContaining("<h2>Step 1</h2>"),
      provenance: { adapter: "chrome-default-applescript", route: "default-profile-dom" },
    });
    const cached = await browser.retrieve(request());
    expect(cached.provenance.route).toBe("default-profile-dom-cache");
    expect(scripts.filter((script) => script.includes("JSON.stringify"))).toHaveLength(1);

    await browser.close();
    expect(scripts.some((script) => script.includes("close window id 731"))).toBe(true);
    expect(browser.status()).toEqual({ state: "stopped", profile: "default" });
  });

  it("reports Chrome's JavaScript from Apple Events prerequisite", async () => {
    const runAppleScript = vi.fn(async (script: string) => {
      if (script.includes("make new window")) return "812";
      if (script.includes("execute active tab")) {
        throw new Error("Executing JavaScript through AppleScript is turned off");
      }
      return "";
    });
    const browser = new DefaultBrowserAdapter({ platform: "darwin", runAppleScript });

    await expect(browser.launch()).resolves.toMatchObject({
      state: "permission-required",
      profile: "default",
      windowId: 812,
      detail: expect.stringContaining("Allow JavaScript from Apple Events"),
    });
    await browser.close();
  });

  it("ignores Chrome's transient internal error document during HTTPS navigation", async () => {
    const transient = JSON.stringify({
      url: "chrome-error://chromewebdata/",
      title: "www.neb.com",
      text: "",
      html: "",
      links: [],
      readyState: "complete",
    });
    let snapshots = 0;
    const runAppleScript = vi.fn(async (script: string) => {
      if (script.includes("make new window")) return "913";
      if (script.includes("exists window id 913")) return "true";
      if (script.includes('javascript "document.title"')) return "";
      if (script.includes("return URL of active tab")) return "about:blank";
      if (script.includes("JSON.stringify")) {
        snapshots += 1;
        return snapshots === 1 ? transient : SNAPSHOT;
      }
      return "";
    });
    const browser = new DefaultBrowserAdapter({
      platform: "darwin",
      runAppleScript,
      sleepImpl: async () => undefined,
    });

    await expect(browser.retrieve(request())).resolves.toMatchObject({
      status: "ok",
      finalUrl: "https://1.1.1.1/protocol",
    });
    expect(snapshots).toBe(2);
    await browser.close();
  });

  it("is unavailable without changing browser state on non-macOS hosts", async () => {
    const runAppleScript = vi.fn();
    const browser = new DefaultBrowserAdapter({ platform: "linux", runAppleScript });
    await expect(browser.available()).resolves.toMatchObject({ available: false });
    expect(runAppleScript).not.toHaveBeenCalled();
  });
});
