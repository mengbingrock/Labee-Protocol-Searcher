// A minimal RFC 6265 cookie jar, shared by every path that fetches HTML or PDF.
//
// `fetch` has no cookie jar, so any site that gates content behind one — a
// country-selection interstitial (idtdna.com sets `Country`), a consent wall,
// or an identity-provider handshake (nature.com bounces through
// idp.nature.com, which sets `idp_session` with `Domain=.nature.com`) — either
// redirects forever or serves a "cookies not supported" stub.
//
// The subtle part, and the reason this is its own module: a jar keyed on the
// exact request hostname is not enough. `idp.nature.com` sets a cookie scoped
// to `.nature.com`; when the redirect chain returns to `www.nature.com` that
// cookie must still be sent. Keying by hostname files it under
// `idp.nature.com` and it is never seen again, which is indistinguishable from
// having no jar at all. So cookies are stored with their `Domain`, `Path` and
// `Secure` attributes and matched the way a browser matches them.

import { type ProviderOptions, fetchWithRetry } from "./providers/types.ts";
import { assertSafePublicUrl } from "./agent/url-policy.ts";

/**
 * The per-hop URL policy every cookie-following fetch should use. Tests and
 * embedders that inject a synthetic fetch get a no-op, because a fake host will
 * never satisfy the public-address policy; real network calls always get the
 * real check, on every redirect hop.
 */
export function defaultUrlValidator(opts: ProviderOptions): (url: string) => Promise<void> {
  if (opts.validateUrl) return opts.validateUrl;
  if (opts.fetchImpl && opts.fetchImpl !== fetch) return async () => undefined;
  return async (candidate: string) => {
    await assertSafePublicUrl(candidate, []);
  };
}

export interface StoredCookie {
  name: string;
  value: string;
  /** Never carries a leading dot; see `hostOnly` for how it is matched. */
  domain: string;
  path: string;
  secure: boolean;
  /** True when the response sent no `Domain`, so only an exact host matches. */
  hostOnly: boolean;
  /** Epoch ms. Undefined for a session cookie, which lives as long as the jar. */
  expiresAt?: number;
}

/** RFC 6265 §5.1.4: the default path is the directory of the request path. */
function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const cut = pathname.lastIndexOf("/");
  return cut <= 0 ? "/" : pathname.slice(0, cut);
}

/** RFC 6265 §5.1.3, minus the public-suffix check (see `acceptDomain`). */
function domainMatches(host: string, domain: string, hostOnly: boolean): boolean {
  if (host === domain) return true;
  if (hostOnly) return false;
  return host.endsWith(`.${domain}`);
}

/** RFC 6265 §5.1.4 path-match: equal, a prefix ending in `/`, or a `/` boundary. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/**
 * Whether a `Domain` attribute may be honoured for this request host. A real
 * jar consults the Public Suffix List so `example.co.uk` cannot set a cookie
 * for `.co.uk`. We have no PSL and do not want the dependency, so we require
 * the attribute to domain-match the host it came from and to contain a dot.
 * That blocks cross-site injection, which is the property that matters here;
 * an over-broad cookie from a host we deliberately requested is not a threat
 * we are defending against.
 */
function acceptDomain(host: string, domain: string): boolean {
  if (!domain.includes(".")) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

function parseExpiry(attrs: Map<string, string>): number | undefined {
  const maxAge = attrs.get("max-age");
  if (maxAge !== undefined) {
    const secs = Number(maxAge);
    // Max-Age wins over Expires when both are present (RFC 6265 §5.3).
    if (Number.isFinite(secs)) return Date.now() + secs * 1000;
  }
  const expires = attrs.get("expires");
  if (expires !== undefined) {
    const when = Date.parse(expires);
    if (!Number.isNaN(when)) return when;
  }
  return undefined;
}

export class CookieJar {
  /** Keyed by name + domain + path, per RFC 6265 §5.3 step 11. */
  private readonly jar = new Map<string, StoredCookie>();

  private static key(c: Pick<StoredCookie, "name" | "domain" | "path">): string {
    return `${c.name}\u0000${c.domain}\u0000${c.path}`;
  }

  /** Absorb every `Set-Cookie` on `res`, interpreted relative to `requestUrl`. */
  harvest(res: Response, requestUrl: string): void {
    const raws = res.headers.getSetCookie?.() ?? [];
    if (raws.length === 0) return;
    const { hostname, pathname } = new URL(requestUrl);
    const host = hostname.toLowerCase();

    for (const raw of raws) {
      const parts = raw.split(";");
      const pair = parts[0]?.trim() ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();

      const attrs = new Map<string, string>();
      for (const attr of parts.slice(1)) {
        const a = attr.trim();
        if (!a) continue;
        const i = a.indexOf("=");
        if (i < 0) attrs.set(a.toLowerCase(), "");
        else attrs.set(a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim());
      }

      // A leading dot is legal and means the same as its absence (RFC 6265 §5.2.3).
      const rawDomain = (attrs.get("domain") ?? "").replace(/^\./, "").toLowerCase();
      const hostOnly = rawDomain === "";
      const domain = hostOnly ? host : rawDomain;
      if (!hostOnly && !acceptDomain(host, domain)) continue;

      const attrPath = attrs.get("path");
      const path = attrPath && attrPath.startsWith("/") ? attrPath : defaultPath(pathname);
      const expiresAt = parseExpiry(attrs);
      const cookie: StoredCookie = {
        name,
        value,
        domain,
        path,
        secure: attrs.has("secure"),
        hostOnly,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };

      // Max-Age=0 / a past Expires is how a server deletes a cookie.
      if (expiresAt !== undefined && expiresAt <= Date.now()) this.jar.delete(CookieJar.key(cookie));
      else this.jar.set(CookieJar.key(cookie), cookie);
    }
  }

  /** The `Cookie` header value for `url`, or "" when nothing matches. */
  header(url: string): string {
    const { hostname, pathname, protocol } = new URL(url);
    const host = hostname.toLowerCase();
    const isSecure = protocol === "https:";
    const now = Date.now();
    const matched: StoredCookie[] = [];

    for (const c of this.jar.values()) {
      if (c.expiresAt !== undefined && c.expiresAt <= now) {
        this.jar.delete(CookieJar.key(c));
        continue;
      }
      if (c.secure && !isSecure) continue;
      if (!domainMatches(host, c.domain, c.hostOnly)) continue;
      if (!pathMatches(pathname || "/", c.path)) continue;
      matched.push(c);
    }

    // Longer paths first (RFC 6265 §5.4); a stable order keeps requests
    // reproducible, which matters for tests and for cache behaviour.
    matched.sort((a, b) => b.path.length - a.path.length || a.name.localeCompare(b.name));
    return matched.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  get size(): number {
    return this.jar.size;
  }
}

const MAX_REDIRECT_HOPS = 8;

/**
 * Follow redirects by hand, carrying cookies across hops the way a browser
 * would — including across sibling subdomains, which is what an identity-provider
 * handshake needs.
 *
 * Manual redirect handling is mandatory rather than a convenience: automatic
 * following would let a public URL bounce to loopback, a private network, or a
 * cloud metadata endpoint before `validateUrl` could inspect the next hop.
 */
export async function fetchFollowingWithCookies(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  validateUrl: (url: string) => Promise<void>,
  jar: CookieJar = new CookieJar(),
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    await validateUrl(current);
    const cookie = jar.header(current);
    const res = await fetchWithRetry(
      doFetch,
      current,
      {
        ...init,
        redirect: "manual",
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      timeoutMs,
      { retries: 0 },
    );
    jar.harvest(res, current);
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    const next = new URL(location, current).toString();
    // A server that redirects a URL to itself (some consent gates do this once
    // the cookie is set) would otherwise burn every remaining hop.
    if (next === current && hop > 0) return res;
    current = next;
  }
  throw new Error(`redirect count exceeded after ${MAX_REDIRECT_HOPS} hops`);
}
