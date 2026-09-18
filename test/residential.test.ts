import { describe, it, expect, afterEach } from "vitest";
import {
  activeResidentialSelector,
  awaitResidentialReady,
  catalogAllowHosts,
  residentialAllows,
  residentialConfig,
  residentialSelectorFor,
  startResidentialAgent,
} from "../src/residential.ts";
import { endpointFlavor, renderWithBrowserless } from "../src/browserless.ts";

/** A complete, valid environment; individual tests remove one key at a time. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    PROTOCOLS_RESIDENTIAL_PROXY: "on",
    RESIDENTIAL_PROXY_CONSENT: "true",
    RESIDENTIAL_PROXY_AGENT_TOKEN: "shared-secret",
    RESIDENTIAL_PROXY_URL: "https://browserless.example.com",
    RESIDENTIAL_PROXY_COUNTRY: "US",
  };
}

describe("residentialConfig", () => {
  it("is off unless explicitly enabled, so an untouched install is unchanged", () => {
    expect(residentialConfig({})).toBeNull();
    expect(residentialConfig({ ...validEnv(), PROTOCOLS_RESIDENTIAL_PROXY: "off" })).toBeNull();
  });

  it("refuses to start without consent, separately from being enabled", () => {
    const env = validEnv();
    delete env.RESIDENTIAL_PROXY_CONSENT;
    expect(() => residentialConfig(env)).toThrow(/consent/i);
  });

  it("reports each missing requirement rather than failing silently", () => {
    for (const [key, pattern] of [
      ["RESIDENTIAL_PROXY_AGENT_TOKEN", /token/i],
      ["RESIDENTIAL_PROXY_COUNTRY", /country/i],
    ] as const) {
      const env = validEnv();
      delete env[key];
      expect(() => residentialConfig(env)).toThrow(pattern);
    }
  });

  it("requires a self-hosted endpoint, since the hosted service has no such feature", () => {
    const env = validEnv();
    delete env.RESIDENTIAL_PROXY_URL;
    expect(() => residentialConfig(env)).toThrow(/RESIDENTIAL_PROXY_URL/);
    // BROWSERLESS_URL is accepted as the same server.
    expect(
      residentialConfig({ ...env, BROWSERLESS_URL: "https://b.example.com" })?.serverUrl,
    ).toBe("https://b.example.com");
  });

  it("rejects a country that is not a two-letter ISO code", () => {
    expect(() => residentialConfig({ ...validEnv(), RESIDENTIAL_PROXY_COUNTRY: "USA" }))
      .toThrow(/two-letter/i);
  });

  it("defaults connection limits and host allowlist for a personal machine", () => {
    const cfg = residentialConfig(validEnv())!;
    expect(cfg.maxConnections).toBe(8);
    // The catalog, not `*`: see catalogAllowHosts for the measured reason.
    expect(cfg.allowHosts).toContain("*.neb.com");
    expect(cfg.allowHosts).toContain("*.sigmaaldrich.com");
    expect(cfg.allowHosts).not.toContain("*");
    expect(cfg.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("carries optional geo labels and a narrowed allowlist through", () => {
    const cfg = residentialConfig({
      ...validEnv(),
      RESIDENTIAL_PROXY_REGION: "CA",
      RESIDENTIAL_PROXY_CITY: "Los Angeles",
      RESIDENTIAL_PROXY_ALLOW_HOSTS: "*.neb.com, sigmaaldrich.com",
      RESIDENTIAL_PROXY_MAX_CONNECTIONS: "3",
    })!;
    expect(cfg.region).toBe("CA");
    expect(cfg.city).toBe("Los Angeles");
    expect(cfg.allowHosts).toEqual(["*.neb.com", "sigmaaldrich.com"]);
    expect(cfg.maxConnections).toBe(3);
  });
});

describe("startResidentialAgent", () => {
  afterEach(() => {
    // Nothing should be left registered between tests.
    expect(activeResidentialSelector()).toBeNull();
  });

  it("returns null when the feature is off", () => {
    expect(startResidentialAgent(() => {}, {})).toBeNull();
  });

  it("reports a misconfiguration without throwing, so the MCP server still starts", () => {
    const lines: string[] = [];
    const env = validEnv();
    delete env.RESIDENTIAL_PROXY_AGENT_TOKEN;
    expect(startResidentialAgent((m) => lines.push(m), env)).toBeNull();
    expect(lines.join("\n")).toMatch(/not started.*token/i);
  });

  it("offers no selector until the server has accepted the registration", () => {
    // Points at a port nothing is listening on: the agent starts and retries,
    // but must never claim an exit is available.
    const handle = startResidentialAgent(() => {}, {
      ...validEnv(),
      RESIDENTIAL_PROXY_URL: "http://127.0.0.1:9",
    })!;
    try {
      expect(handle.connected).toBe(false);
      expect(activeResidentialSelector()).toBeNull();
    } finally {
      handle.stop();
    }
  });
});

describe("browserless residential routing", () => {
  const html = `<html><body><article><p>${"Buffer at 37 °C. ".repeat(30)}</p></article></body></html>`;
  const cfg = { endpoint: "https://b.example.com", token: "tok", timeoutMs: 5_000 };

  /** `/unblock` answers JSON, `/content` answers the HTML itself. */
  function capture(seen: string[]): typeof fetch {
    return (async (url: string) => {
      seen.push(url);
      return url.includes("/content")
        ? new Response(html, { status: 200 })
        : new Response(JSON.stringify({ content: html }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("asks for a residential exit only when one is registered", async () => {
    const seen: string[] = [];
    await renderWithBrowserless("https://example.com/a", capture(seen), cfg);
    expect(seen[0]).not.toContain("residentialProxy");

    await renderWithBrowserless("https://example.com/a", capture(seen), cfg, {
      country: "US",
      region: "CA",
    });
    expect(seen[1]).toContain("residentialProxy=true");
    expect(seen[1]).toContain("residentialProxyCountry=US");
    expect(seen[1]).toContain("residentialProxyRegion=CA");
  });

  it("still sends the token when routing residentially", async () => {
    const seen: string[] = [];
    await renderWithBrowserless("https://example.com/a", capture(seen), cfg, { country: "US" });
    expect(seen[0]).toContain("token=tok");
  });

  // The route is chosen from the endpoint, not from whether a residential exit
  // is registered. Keying it on the selector meant the first fetch after
  // startup -- before registration completed -- posted to /unblock, which our
  // fork does not serve, and the 404 surfaced as a bare "no result".
  it("uses /content on our fork whether or not an exit is registered", async () => {
    const seen: string[] = [];
    const plain = await renderWithBrowserless("https://example.com/a", capture(seen), cfg);
    expect(seen[0]).toContain("/content");
    expect(seen[0]).not.toContain("/unblock");
    expect(plain).toContain("Buffer at 37");

    const resident = await renderWithBrowserless(
      "https://example.com/a",
      capture(seen),
      cfg,
      { country: "US" },
    );
    expect(seen[1]).toContain("/content");
    expect(resident).toContain("Buffer at 37");
  });

  it("uses /unblock only against hosted browserless.io, and reads its JSON body", async () => {
    const seen: string[] = [];
    const hostedCfg = { ...cfg, endpoint: "https://production-sfo.browserless.io" };
    const out = await renderWithBrowserless("https://example.com/a", capture(seen), hostedCfg);
    expect(seen[0]).toContain("/unblock");
    expect(out).toContain("Buffer at 37");
  });

  it("does not ask hosted browserless.io for a residential exit it cannot provide", async () => {
    const seen: string[] = [];
    const hostedCfg = { ...cfg, endpoint: "https://production-sfo.browserless.io" };
    await renderWithBrowserless("https://example.com/a", capture(seen), hostedCfg, {
      country: "US",
    });
    expect(seen[0]).not.toContain("residentialProxy");
  });

  it("treats a lookalike host as our fork rather than inheriting hosted routes", () => {
    expect(endpointFlavor(new URL("https://browserless.io.example.com/x"))).toBe("self-hosted");
    expect(endpointFlavor(new URL("https://browserless.truegrit.dev/x"))).toBe("self-hosted");
    expect(endpointFlavor(new URL("https://production-sfo.browserless.io/x"))).toBe("hosted");
  });
});

describe("allowlist and routing", () => {
  it("derives the default allowlist from the catalog, as wildcard hosts", () => {
    const hosts = catalogAllowHosts();
    expect(hosts).toContain("*.neb.com");
    expect(hosts).toContain("*.emdmillipore.com");
    expect(hosts).toContain("*.cell.com"); // from cell.com/star-protocols: path stripped
    expect(hosts.every((h) => h.startsWith("*."))).toBe(true);
    expect(hosts).not.toContain("*");
  });

  it("honours an explicit allowlist, `*` included", () => {
    expect(residentialConfig({ ...validEnv(), RESIDENTIAL_PROXY_ALLOW_HOSTS: "*" })?.allowHosts).toEqual(["*"]);
  });

  it("routes only allowed hosts residentially; everything else stays datacenter", () => {
    // Points at a dead port so the agent never connects; the allowlist check
    // is independent of connection state and must still answer.
    const handle = startResidentialAgent(() => {}, {
      ...validEnv(),
      RESIDENTIAL_PROXY_URL: "http://127.0.0.1:9",
    })!;
    try {
      expect(residentialAllows("https://www.neb.com/protocols/x")).toBe(true);
      expect(residentialAllows("https://neb.com/x")).toBe(true);
      // An open-access repository URL from the fulltext tiers: not in the catalog.
      expect(residentialAllows("https://europepmc.org/articles/PMC1")).toBe(false);
      expect(residentialAllows("not a url")).toBe(false);
      // Not connected yet, so no selector even for an allowed host.
      expect(residentialSelectorFor("https://www.neb.com/protocols/x")).toBeNull();
    } finally {
      handle.stop();
    }
  });

  it("does not wait for readiness when no exit is configured", async () => {
    const started = Date.now();
    expect(await awaitResidentialReady(5_000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("gives up waiting at the deadline when the exit never connects", async () => {
    const handle = startResidentialAgent(() => {}, {
      ...validEnv(),
      RESIDENTIAL_PROXY_URL: "http://127.0.0.1:9",
    })!;
    try {
      const started = Date.now();
      expect(await awaitResidentialReady(300)).toBe(false);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      handle.stop();
    }
  });
});

describe("residential render retry", () => {
  const cfg = { endpoint: "https://b.example.com", token: "tok", timeoutMs: 5_000 };
  const html = `<html><body><article>${"Buffer at 37 °C. ".repeat(30)}</article></body></html>`;

  it("retries a residential render once when the server refuses it", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1
        ? new Response("net::ERR_TUNNEL_CONNECTION_FAILED", { status: 500 })
        : new Response(html, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await renderWithBrowserless("https://www.neb.com/x", flaky, cfg, { country: "US" });
    expect(calls).toBe(2);
    expect(out).toContain("Buffer at 37");
  });

  it("does not retry a datacenter render, which has no teardown window", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    expect(await renderWithBrowserless("https://www.neb.com/x", failing, cfg)).toBeNull();
    expect(calls).toBe(1);
  });

  it("stops after the single retry", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    expect(await renderWithBrowserless("https://www.neb.com/x", failing, cfg, { country: "US" })).toBeNull();
    expect(calls).toBe(2);
  });
});
