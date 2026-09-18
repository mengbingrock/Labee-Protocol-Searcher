// Register this PC as a residential exit for the remote browser.
//
// browserless.ts explains why the hosted-browser fallback is never used for
// entitled retrieval: entitlement is decided by IP, and a request routed
// through a datacenter comes from a different network than the one the
// entitlement verdict describes. That constraint is a property of *where the
// browser calls from*, not of the browser itself.
//
// This module removes it. The MCP layer running on the user's PC opens an
// outbound WebSocket to the browserless server and offers itself as a
// residential exit; the server then routes that user's browser traffic back out
// through this machine. The remote browser ends up calling from the same
// network the entitlement verdict was computed for — the user's own.
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

import { hostname } from "node:os";

import {
  ResidentialProxyAgent,
  makeResidentialProxyAgentId,
} from "./residential/agent.ts";

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

export interface ResidentialHandle {
  /** True once the server has accepted the registration. */
  readonly connected: boolean;
  readonly id: string;
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

  const allowHosts = (env.RESIDENTIAL_PROXY_ALLOW_HOSTS ?? "*")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

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

/**
 * The selector to send with a browserless call, or null when no exit from this
 * machine is currently registered. Checked per call rather than cached: a
 * dropped control channel must stop us asking the server to route through an
 * agent that is no longer there.
 */
export function activeResidentialSelector(): ResidentialSelector | null {
  if (!active?.connected || !activeConfig) return null;
  return {
    city: activeConfig.city,
    country: activeConfig.country,
    region: activeConfig.region,
  };
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
    stop() {
      controller.abort();
      agent.stop();
    },
  };
}
