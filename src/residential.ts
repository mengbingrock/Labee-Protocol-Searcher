// Register this PC as a residential exit for the remote browser.
//
// browserless.ts explains why the hosted-browser fallback is never used for
// entitled retrieval: entitlement is decided by IP, and a request routed
// through a datacenter comes from a different network than the one the
// entitlement verdict describes. That constraint is a property of *where the
// browser calls from*, not of the browser itself.
//
// This module removes it. The stdio bridge running on the user's PC opens an
// outbound WebSocket to the browserless server and offers itself as a
// residential exit. It forwards safe routing metadata with relevant MCP calls;
// the remote service then routes only selected browser retries back out through
// this machine. The remote browser ends up calling from the user's own network.
//
// Four properties this deliberately keeps:
//
//   - Off unless asked for. Absent configuration is "not enabled", never an
//     error, exactly like the browserless fallback it complements.
//   - Consent is explicit and separate from enabling. Lending a machine's
//     network is not something a config default should decide.
//   - stdio only. In `--http` mode this process *is* the hosted server, and a
//     server offering itself as a residential exit would be a datacenter IP
//     wearing the wrong label.
//   - Never fatal. A refused or dropped registration leaves the MCP server
//     running and every other retrieval path untouched.
//
// The wire protocol is end-to-end encrypted independently of TLS (X25519 +
// ChaCha20-Poly1305, keyed off the shared agent token), so whatever terminates
// TLS in front of the server -- a CDN, a load balancer -- relays ciphertext it
// cannot read. See residential/README.md for the vendored implementation.

import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";

import {
  ResidentialProxyAgent,
  hostMatchesAllowlist,
  makeResidentialProxyAgentId,
} from "./residential/agent.ts";
import { VENDORS } from "./vendors.ts";

/**
 * The hosts this exit will carry when RESIDENTIAL_PROXY_ALLOW_HOSTS is unset:
 * every source in the catalog, as `*.host` so subdomains match.
 *
 * Not `*`, for two reasons that were measured rather than assumed
 * (2026-09-17). First, a headless Chrome opens several background connections
 * per render — Google update and telemetry endpoints — and with `*` every one
 * of them takes a slot on this agent; at the default of 8 that usually leaves
 * room for the real target, at 4 it never did, and the target's CONNECT was
 * refused as `ERR_TUNNEL_CONNECTION_FAILED`. A narrow allowlist makes those
 * CONNECTs fail immediately without occupying a slot. Second, this lends out
 * a network connection, and the sensible default is to lend it only for the
 * sites this tool actually fetches.
 */
export function catalogAllowHosts(): string[] {
  const hosts = new Set<string>();
  for (const vendor of VENDORS) {
    const host = vendor.searchSite.split("/")[0]!.toLowerCase().replace(/^www\./, "");
    if (host) hosts.add(`*.${host}`);
  }
  // Dependencies required by the measured publisher search flows. NEB's
  // result UI is served by Coveo; Cell/STAR uses Cloudflare challenges; JoVE,
  // QIAGEN and Promega load Google/reCAPTCHA assets. Keep this explicit rather
  // than widening the exit to arbitrary hosts.
  for (const host of [
    "*.coveo.com",
    "*.cloudflare.com",
    "*.google.com",
    "*.gstatic.com",
    "*.recaptcha.net",
  ]) {
    hosts.add(host);
  }
  return [...hosts];
}

/** Lower than the upstream default of 20: this is somebody's laptop. */
const DEFAULT_MAX_CONNECTIONS = 8;

export interface ResidentialConfig {
  allowHosts: string[];
  city?: string | undefined;
  controlProxy?: string | undefined;
  country: string;
  id: string;
  maxConnections: number;
  region?: string | undefined;
  serverUrl: string;
  token: string;
}

export interface ResidentialSelector {
  city?: string | undefined;
  country: string;
  region?: string | undefined;
}

/**
 * A connected stdio proxy advertises this capability to the remote MCP server.
 * It contains routing labels and the local agent's own destination allowlist,
 * but never the residential-agent secret. The remote server scopes the offer
 * to one authenticated MCP request and chooses the residential route only for
 * a publisher configured to prefer it or for a datacenter retry.
 */
export interface ResidentialOffer {
  agentId: string;
  allowHosts: string[];
  selector: ResidentialSelector;
}

export const RESIDENTIAL_OFFER_HEADER = "x-labee-residential-offer";

export interface ResidentialHandle {
  /** True once the server has accepted the registration. */
  readonly connected: boolean;
  readonly id: string;
  /** Safe routing metadata for the remote MCP server; null until connected. */
  readonly offer: ResidentialOffer | null;
  stop(): void;
}

/**
 * Exposes the connection state the base class tracks internally, so callers can
 * ask "is a residential exit available right now?" without inspecting logs.
 */
class ObservableResidentialAgent extends ResidentialProxyAgent {
  public get connected(): boolean {
    return this.ready;
  }
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Read the configuration, or null when the feature is simply not enabled.
 *
 * Enabled-but-unusable throws instead of returning null, and the distinction is
 * the point: silence is right for a feature nobody asked for, and wrong for one
 * that was asked for and cannot start. The caller turns the throw into a
 * stderr line, never a crash.
 */
export function residentialConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResidentialConfig | null {
  if (!truthy(env.PROTOCOLS_RESIDENTIAL_PROXY)) return null;

  if (!truthy(env.RESIDENTIAL_PROXY_CONSENT)) {
    throw new Error(
      "PROTOCOLS_RESIDENTIAL_PROXY is on but RESIDENTIAL_PROXY_CONSENT is not set. " +
        "Lending this machine's network connection requires explicit consent from its owner.",
    );
  }

  const token = optional(env.RESIDENTIAL_PROXY_AGENT_TOKEN);
  if (!token) {
    throw new Error("RESIDENTIAL_PROXY_AGENT_TOKEN is required to register a residential exit");
  }

  // The hosted browserless.io service does not offer this; it only works
  // against a self-hosted server that has RESIDENTIAL_PROXY_ENABLED set, so
  // there is deliberately no default endpoint to fall back to.
  const serverUrl = optional(env.RESIDENTIAL_PROXY_URL) ?? optional(env.BROWSERLESS_URL);
  if (!serverUrl) {
    throw new Error(
      "RESIDENTIAL_PROXY_URL (or BROWSERLESS_URL) must point at a self-hosted browserless server",
    );
  }

  // Self-declared, and treated as such by the server: it is a routing label, not
  // a verified geolocation.
  const country = optional(env.RESIDENTIAL_PROXY_COUNTRY);
  if (!country || !/^[a-z]{2}$/i.test(country)) {
    throw new Error("RESIDENTIAL_PROXY_COUNTRY must be a two-letter ISO country code");
  }

  const configuredMax = Number(env.RESIDENTIAL_PROXY_MAX_CONNECTIONS);
  const maxConnections =
    Number.isInteger(configuredMax) && configuredMax > 0
      ? configuredMax
      : DEFAULT_MAX_CONNECTIONS;

  // An explicit setting is the operator's call, `*` included. Absent one, the
  // catalog is the allowlist — see catalogAllowHosts for why not `*`.
  const configuredHosts = optional(env.RESIDENTIAL_PROXY_ALLOW_HOSTS);
  const allowHosts = configuredHosts
    ? configuredHosts.split(",").map((h) => h.trim()).filter(Boolean)
    : catalogAllowHosts();

  const safeHostname = hostname().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  const id =
    optional(env.RESIDENTIAL_PROXY_AGENT_ID) ??
    `${safeHostname || "labee"}-${makeResidentialProxyAgentId().slice(0, 8)}`;

  return {
    allowHosts: allowHosts.length ? allowHosts : ["*"],
    city: optional(env.RESIDENTIAL_PROXY_CITY),
    controlProxy: optional(env.RESIDENTIAL_PROXY_CONTROL_PROXY),
    country,
    id,
    maxConnections,
    region: optional(env.RESIDENTIAL_PROXY_REGION),
    serverUrl,
    token,
  };
}

let active: ObservableResidentialAgent | null = null;
let activeConfig: ResidentialConfig | null = null;
const requestResidentialOffer = new AsyncLocalStorage<ResidentialOffer>();

function selectorFromConfig(cfg: ResidentialConfig): ResidentialSelector {
  return {
    city: cfg.city,
    country: cfg.country,
    region: cfg.region,
  };
}

function offerFromConfig(cfg: ResidentialConfig): ResidentialOffer {
  return {
    agentId: cfg.id,
    allowHosts: [...cfg.allowHosts],
    selector: selectorFromConfig(cfg),
  };
}

/** The connected local exit, if this process currently owns one. */
export function activeResidentialOffer(): ResidentialOffer | null {
  if (!active?.connected || !activeConfig) return null;
  return offerFromConfig(activeConfig);
}

/**
 * Encode routing metadata for an authenticated MCP request. Base64url keeps
 * user-supplied geo labels out of raw HTTP header syntax.
 */
export function encodeResidentialOffer(offer: ResidentialOffer): string {
  return Buffer.from(JSON.stringify(offer), "utf8").toString("base64url");
}

/** Parse and strictly bound an offer received by the remote MCP endpoint. */
export function decodeResidentialOffer(value: string | undefined): ResidentialOffer | null {
  if (!value || value.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length > 8_192) return null;
    const parsed = JSON.parse(decoded.toString("utf8")) as {
      agentId?: unknown;
      allowHosts?: unknown;
      selector?: { city?: unknown; country?: unknown; region?: unknown };
    };
    if (typeof parsed.agentId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(parsed.agentId)) {
      return null;
    }
    if (!Array.isArray(parsed.allowHosts) || parsed.allowHosts.length < 1 || parsed.allowHosts.length > 128) {
      return null;
    }
    if (parsed.allowHosts.some((entry) => typeof entry !== "string")) return null;
    const allowHosts = (parsed.allowHosts as string[]).map((entry) => entry.trim().toLowerCase());
    if (allowHosts.some((entry) =>
      !entry || entry.length > 253 || /[\u0000-\u0020\u007f/\\:@]/.test(entry) ||
      (entry !== "*" && !/^(?:\*\.)?[a-z0-9.-]+$/.test(entry)))) {
      return null;
    }
    const country = parsed.selector?.country;
    if (typeof country !== "string") return null;
    if (!/^[a-z]{2}$/i.test(country)) return null;
    const optionalLabel = (label: unknown): string | undefined | null => {
      if (label === undefined) return undefined;
      if (typeof label !== "string") return null;
      const text = label.trim();
      if (!text || text.length > 64 || /[\u0000-\u001f\u007f]/.test(text)) return null;
      return text;
    };
    const city = optionalLabel(parsed.selector?.city);
    const region = optionalLabel(parsed.selector?.region);
    if (city === null || region === null) return null;
    return {
      agentId: parsed.agentId,
      allowHosts,
      selector: {
        ...(city ? { city } : {}),
        country,
        ...(region ? { region } : {}),
      },
    };
  } catch {
    return null;
  }
}

/** Run one remote MCP request with its caller's residential capability. */
export function withResidentialOffer<T>(
  offer: ResidentialOffer | null,
  fn: () => T,
): T {
  return offer ? requestResidentialOffer.run(offer, fn) : fn();
}

function currentResidentialOffer(): ResidentialOffer | null {
  return requestResidentialOffer.getStore() ?? activeResidentialOffer();
}

/**
 * The selector to send with a browserless call, or null when no exit from this
 * machine is currently registered. Checked per call rather than cached: a
 * dropped control channel must stop us asking the server to route through an
 * agent that is no longer there.
 */
export function activeResidentialSelector(): ResidentialSelector | null {
  return currentResidentialOffer()?.selector ?? null;
}

/** Whether the registered exit would carry a connection to this URL's host. */
export function residentialAllows(url: string): boolean {
  // This answers whether the configured exit permits a host, independently of
  // whether its asynchronous registration has completed. The selector helper
  // below separately requires a connected/request-scoped offer.
  const offer = requestResidentialOffer.getStore()
    ?? (activeConfig ? offerFromConfig(activeConfig) : null);
  if (!offer) return false;
  try {
    return hostMatchesAllowlist(new URL(url).hostname, offer.allowHosts);
  } catch {
    return false;
  }
}

/**
 * The selector for a render of `url`, or null when the render should leave
 * from the server's own address instead.
 *
 * A host outside this exit's allowlist must not be routed residentially: the
 * agent would refuse the CONNECT and the whole render would fail, where a
 * datacenter render might have succeeded. That case is real — the open-access
 * tiers in fulltext.ts hand this fallback arbitrary publisher and repository
 * URLs, none of which are in the catalog.
 */
export function residentialSelectorFor(url: string): ResidentialSelector | null {
  const offer = currentResidentialOffer();
  if (!offer) return null;
  try {
    return hostMatchesAllowlist(new URL(url).hostname, offer.allowHosts)
      ? offer.selector
      : null;
  } catch {
    return null;
  }
}

/**
 * Wait, bounded, for the exit to finish registering. Registration is
 * asynchronous and the first fetch after startup used to lose the race and go
 * out from the datacenter — which is not an error, just not what the operator
 * enabled the exit for. Resolves false at once when no exit is configured, so
 * the common case costs nothing.
 */
export async function awaitResidentialReady(timeoutMs: number): Promise<boolean> {
  // A request-scoped offer was attached only after its stdio agent reported a
  // completed handshake, so the remote server need not (and cannot) wait on a
  // local object it does not own.
  if (requestResidentialOffer.getStore()) return true;
  // Hold the agent we started waiting on. A stopped agent clears `active`
  // asynchronously, so reading the module variable inside the loop would race
  // that teardown; if the active agent changes, this wait is void.
  const agent = active;
  if (!agent) return false;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!agent.connected) {
    if (active !== agent || Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return active === agent;
}

/**
 * Start the agent in the background. Returns null when the feature is off.
 * `log` defaults to stderr because stdout on this process carries the MCP
 * JSON-RPC stream and must not be written to by anything else.
 */
export function startResidentialAgent(
  log: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
  env: NodeJS.ProcessEnv = process.env,
): ResidentialHandle | null {
  let cfg: ResidentialConfig | null;
  try {
    cfg = residentialConfig(env);
  } catch (error) {
    log(`[residential] not started: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!cfg) return null;

  const controller = new AbortController();
  const agent = new ObservableResidentialAgent({
    allowHosts: cfg.allowHosts,
    allowedPorts: [80, 443],
    controlProxy: cfg.controlProxy,
    descriptor: {
      city: cfg.city,
      country: cfg.country,
      id: cfg.id,
      maxConnections: cfg.maxConnections,
      region: cfg.region,
    },
    log: (message) => log(`[residential] ${message}`),
    serverURL: cfg.serverUrl,
    token: cfg.token,
  });

  active = agent;
  activeConfig = cfg;

  // Floating on purpose: `run` only settles when the agent stops, and the MCP
  // server must not wait on it. Reconnection is handled inside `run`.
  void agent
    .run(controller.signal)
    .catch((error) =>
      log(`[residential] agent stopped: ${error instanceof Error ? error.message : String(error)}`),
    )
    .finally(() => {
      if (active === agent) {
        active = null;
        activeConfig = null;
      }
    });

  log(
    `[residential] offering this machine as an exit (${cfg.country.toUpperCase()}` +
      `${cfg.region ? `/${cfg.region}` : ""}), id ${cfg.id}, max ${cfg.maxConnections} connections`,
  );

  return {
    get connected() {
      return agent.connected;
    },
    id: cfg.id,
    get offer() {
      return agent.connected ? offerFromConfig(cfg) : null;
    },
    stop() {
      controller.abort();
      agent.stop();
    },
  };
}
