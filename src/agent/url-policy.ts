import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Lookup = typeof dnsLookup;

function blockedIpv4(address: string): boolean {
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function blockedIpv6(address: string): boolean {
  const value = address.toLowerCase().split("%", 1)[0]!;
  if (value === "::" || value === "::1") return true;
  if (/^(fc|fd)/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value)) return true;
  if (value.startsWith("2001:db8:")) return true;
  const words = ipv6Words(value);
  if (!words) return true;

  // URL parsers canonicalise dotted IPv4-mapped literals before we see them:
  // `::ffff:127.0.0.1` becomes `::ffff:7f00:1`. Decode the final 32 bits for
  // both the mapped form and the deprecated IPv4-compatible form.
  const mapped = words.slice(0, 5).every((word) => word === 0)
    && (words[5] === 0 || words[5] === 0xffff);
  if (mapped && blockedIpv4(ipv4FromWords(words[6]!, words[7]!))) return true;

  // RFC 6052's well-known NAT64 prefix embeds IPv4 in the final 32 bits. A
  // public-looking IPv6 literal must not smuggle loopback, RFC1918, link-local,
  // or metadata IPv4 through that prefix. RFC 8215's local-use /48 is not
  // globally routable, so conservatively reject it in full.
  const wellKnownNat64 = words[0] === 0x64 && words[1] === 0xff9b
    && words.slice(2, 6).every((word) => word === 0);
  if (wellKnownNat64 && blockedIpv4(ipv4FromWords(words[6]!, words[7]!))) return true;
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return true;
  return false;
}

function ipv4FromWords(high: number, low: number): string {
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

/** Expand an IPv6 literal into eight 16-bit words. */
function ipv6Words(address: string): number[] | null {
  let value = address;
  const dotted = /(^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dotted) {
    const octets = dotted[2]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const high = (octets[0]! << 8) | octets[1]!;
    const low = (octets[2]! << 8) | octets[3]!;
    const replacement = `${high.toString(16)}:${low.toString(16)}`;
    value = `${value.slice(0, dotted.index + dotted[1]!.length)}${replacement}`;
  }
  if ((value.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = value.split("::");
  const parse = (part: string | undefined): number[] | null => {
    if (!part) return [];
    const pieces = part.split(":");
    if (pieces.some((piece) => !/^[0-9a-f]{1,4}$/i.test(piece))) return null;
    return pieces.map((piece) => Number.parseInt(piece, 16));
  };
  const left = parse(leftRaw);
  const right = parse(rightRaw);
  if (!left || !right) return null;
  if (value.includes("::")) {
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    return [...left, ...Array<number>(fill).fill(0), ...right];
  }
  return left.length === 8 ? left : null;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4(address);
  if (family === 6) return !blockedIpv6(address);
  return false;
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

function allowedHost(host: string, allowed: readonly string[]): boolean {
  const normalized = normalizedHost(host);
  return allowed.some((item) => {
    const base = normalizedHost(item);
    return normalized === base || normalized.endsWith(`.${base}`);
  });
}

export async function assertSafePublicUrl(
  raw: string,
  allowedHosts: readonly string[] = [],
  lookup: Lookup = dnsLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("unsafe-url: invalid URL");
  }
  if (url.protocol !== "https:") throw new Error("unsafe-url: only HTTPS navigation is allowed");
  if (url.username || url.password) throw new Error("unsafe-url: URL credentials are forbidden");
  const host = normalizedHost(url.hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("unsafe-url: localhost is forbidden");
  }
  if (allowedHosts.length > 0 && !allowedHost(host, allowedHosts)) {
    throw new Error(`unsafe-url: host ${host} is outside the source allowlist`);
  }
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new Error(`unsafe-url: non-public address ${host}`);
    return url;
  }
  const answers = await lookup(host, { all: true, verbatim: true });
  if (answers.length === 0 || answers.some((answer) => !isPublicAddress(answer.address))) {
    throw new Error(`unsafe-url: ${host} resolves to a non-public address`);
  }
  return url;
}

export function assertLoopbackCdpEndpoint(raw: string): URL {
  const url = new URL(raw);
  const host = normalizedHost(url.hostname);
  if (url.protocol !== "http:" || !(host === "127.0.0.1" || host === "::1")) {
    throw new Error("CDP endpoint must use HTTP on a literal loopback address");
  }
  if (url.username || url.password) throw new Error("CDP endpoint credentials are forbidden");
  if (url.pathname !== "/" || url.search || url.hash || url.href !== `${url.origin}/`) {
    throw new Error("CDP endpoint must be an origin with no path, query, or fragment");
  }
  return url;
}

/** Validate the browser websocket advertised by a loopback CDP discovery page. */
export function assertLoopbackCdpWebSocketEndpoint(raw: string, control: URL): URL {
  const url = new URL(raw);
  const host = normalizedHost(url.hostname);
  const controlHost = normalizedHost(control.hostname);
  if (url.protocol !== "ws:" || !(host === "127.0.0.1" || host === "::1")) {
    throw new Error("CDP websocket must use WS on a literal loopback address");
  }
  if (host !== controlHost || url.port !== control.port) {
    throw new Error("CDP websocket must use the same loopback address and port as discovery");
  }
  if (url.username || url.password || url.search || url.hash || url.href.includes("?") || url.href.includes("#")) {
    throw new Error("CDP websocket credentials, query, and fragment are forbidden");
  }
  if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(url.pathname)) {
    throw new Error("CDP websocket path is invalid");
  }
  return url;
}
