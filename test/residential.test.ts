import { describe, it, expect, afterEach } from "vitest";
import {
  activeResidentialSelector,
  residentialConfig,
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
    expect(cfg.allowHosts).toEqual(["*"]);
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
