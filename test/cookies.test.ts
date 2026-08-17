import { describe, it, expect } from "vitest";
import { CookieJar, fetchFollowingWithCookies } from "../src/cookies.ts";

function res(setCookie: string[], status = 200, location?: string): Response {
  const headers = new Headers();
  for (const c of setCookie) headers.append("set-cookie", c);
  if (location) headers.set("location", location);
  return new Response("", { status, headers });
}

const noValidate = async (): Promise<void> => undefined;

describe("CookieJar", () => {
  it("sends a Domain-scoped cookie to a sibling subdomain", () => {
    // The nature.com case: idp.nature.com sets the session, www.nature.com needs it.
    const jar = new CookieJar();
    jar.harvest(
      res(["idp_session=abc; Domain=.nature.com; Path=/; Secure; HttpOnly"]),
      "https://idp.nature.com/authorize",
    );
    expect(jar.header("https://www.nature.com/articles/x.pdf")).toBe("idp_session=abc");
  });

  it("keeps a cookie with no Domain host-only", () => {
    const jar = new CookieJar();
    jar.harvest(res(["a=1; Path=/"]), "https://idp.example.com/authorize");
    expect(jar.header("https://idp.example.com/x")).toBe("a=1");
    expect(jar.header("https://www.example.com/x")).toBe("");
  });

  it("refuses a Domain that does not cover the responding host", () => {
    const jar = new CookieJar();
    jar.harvest(res(["evil=1; Domain=.victim.com"]), "https://attacker.example/x");
    expect(jar.header("https://www.victim.com/")).toBe("");
    expect(jar.size).toBe(0);
  });

  it("refuses a dotless Domain", () => {
    const jar = new CookieJar();
    jar.harvest(res(["a=1; Domain=com"]), "https://x.com/");
    expect(jar.size).toBe(0);
  });

  it("withholds a Secure cookie from a plain-http request", () => {
    const jar = new CookieJar();
    jar.harvest(res(["s=1; Domain=example.com; Secure"]), "https://example.com/");
    expect(jar.header("http://example.com/")).toBe("");
    expect(jar.header("https://example.com/")).toBe("s=1");
  });

  it("honours Path scoping, including the / boundary", () => {
    const jar = new CookieJar();
    jar.harvest(res(["p=1; Path=/deep"]), "https://example.com/deep/page");
    expect(jar.header("https://example.com/deep")).toBe("p=1");
    expect(jar.header("https://example.com/deep/er")).toBe("p=1");
    expect(jar.header("https://example.com/deeper")).toBe("");
  });

  it("defaults Path to the request directory", () => {
    const jar = new CookieJar();
    jar.harvest(res(["d=1"]), "https://example.com/a/b/c");
    expect(jar.header("https://example.com/a/b/other")).toBe("d=1");
    expect(jar.header("https://example.com/a/elsewhere")).toBe("");
  });

  it("treats Max-Age=0 as a deletion", () => {
    const jar = new CookieJar();
    jar.harvest(res(["k=1; Domain=example.com"]), "https://example.com/");
    expect(jar.header("https://example.com/")).toBe("k=1");
    jar.harvest(res(["k=; Domain=example.com; Max-Age=0"]), "https://example.com/");
    expect(jar.header("https://example.com/")).toBe("");
  });

  it("drops an expired cookie rather than sending it", () => {
    const jar = new CookieJar();
    jar.harvest(
      res(["old=1; Domain=example.com; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]),
      "https://example.com/",
    );
    expect(jar.header("https://example.com/")).toBe("");
  });

  it("orders longer paths first so the header is deterministic", () => {
    const jar = new CookieJar();
    jar.harvest(res(["short=1; Path=/"]), "https://example.com/");
    jar.harvest(res(["long=1; Path=/a/b"]), "https://example.com/a/b/c");
    expect(jar.header("https://example.com/a/b/c")).toBe("long=1; short=1");
  });
});

describe("fetchFollowingWithCookies", () => {
  it("carries a Domain cookie across a cross-subdomain redirect chain", async () => {
    const seen: { url: string; cookie: string | null }[] = [];
    const doFetch = (async (url: string, init: RequestInit) => {
      const cookie = new Headers(init.headers).get("cookie");
      seen.push({ url, cookie });
      if (url.startsWith("https://www.site.test/article")) {
        return seen.length === 1
          ? res([], 303, "https://idp.site.test/authorize")
          : new Response("FULL TEXT", { status: 200 });
      }
      return res(["idp_session=zzz; Domain=.site.test; Path=/"], 302, "https://www.site.test/article");
    }) as unknown as typeof fetch;

    const out = await fetchFollowingWithCookies(
      doFetch,
      "https://www.site.test/article",
      {},
      1000,
      noValidate,
    );
    expect(await out.text()).toBe("FULL TEXT");
    expect(seen.map((s) => s.cookie)).toEqual([null, null, "idp_session=zzz"]);
  });

  it("validates every hop, not just the first", async () => {
    const checked: string[] = [];
    const doFetch = (async (url: string) =>
      url.endsWith("/one")
        ? res([], 302, "https://two.test/two")
        : new Response("ok", { status: 200 })) as unknown as typeof fetch;
    await fetchFollowingWithCookies(doFetch, "https://one.test/one", {}, 1000, async (u) => {
      checked.push(u);
    });
    expect(checked).toEqual(["https://one.test/one", "https://two.test/two"]);
  });

  it("stops instead of burning hops when a URL redirects to itself", async () => {
    let calls = 0;
    const doFetch = (async () => {
      calls++;
      return res(["c=1"], 302, "https://loop.test/x");
    }) as unknown as typeof fetch;
    const out = await fetchFollowingWithCookies(doFetch, "https://loop.test/x", {}, 1000, noValidate);
    expect(out.status).toBe(302);
    expect(calls).toBe(2);
  });

  it("throws once the hop budget is exhausted", async () => {
    let n = 0;
    const doFetch = (async () =>
      res([], 302, `https://hop.test/${n++}`)) as unknown as typeof fetch;
    await expect(
      fetchFollowingWithCookies(doFetch, "https://hop.test/start", {}, 1000, noValidate),
    ).rejects.toThrow(/redirect count exceeded/);
  });
});
