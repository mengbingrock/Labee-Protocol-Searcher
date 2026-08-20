import { afterEach, describe, expect, it } from "vitest";
import {
  commitHostBrowserSearch,
  fetchHostBrowserCapture,
  prepareHostBrowserSearch,
  resetHostBrowserStateForTests,
} from "../src/agent/host-browser.ts";

const emptyBase = (query: string) => ({
  query,
  results: [],
  sources: [],
  unknownSources: [],
  partial: false,
});

describe("host-browser NEB capture protocol", () => {
  afterEach(() => resetHostBrowserStateForTests());

  it("prepares a bounded NEB search and caches rendered-text fallback", () => {
    const task = prepareHostBrowserSearch("Golden Gate assembly", 99, emptyBase("Golden Gate assembly"));
    expect(task).toMatchObject({ kind: "neb-search", limit: 10 });
    expect(task.searchUrl).toContain("searchValue=Golden%20Gate%20assembly");
    expect(task.instructions.join(" ")).toContain("Codex's integrated Browser");

    const committed = commitHostBrowserSearch(task.captureId, [{
      title: "Golden Gate Assembly Protocol",
      url: "https://www.neb.com/en-us/protocols/golden-gate-assembly",
      text: "Step 1. Mix the reaction. Step 2. Incubate at 37°C.",
    }]);
    const id = "url:https://www.neb.com/en-us/protocols/golden-gate-assembly";
    expect(committed.capturedIds).toEqual([id]);
    expect(committed.formats[id]).toBe("rendered-text");
    expect(fetchHostBrowserCapture(id)).toContain("raw HTML was not available");
  });

  it("rejects non-NEB captures and does not consume the token", () => {
    const task = prepareHostBrowserSearch("ligation", 1, emptyBase("ligation"));
    expect(() => commitHostBrowserSearch(task.captureId, [{
      title: "Untrusted",
      url: "https://neb.com.evil.example/protocol",
      html: "<main>bad</main>",
    }])).toThrow("is not an NEB domain");

    expect(() => commitHostBrowserSearch(task.captureId, [{
      title: "Ligation protocol",
      url: "https://www.neb.com/en-us/protocols/ligation",
      html: "<main>valid</main>",
    }])).not.toThrow();
  });

  it("consumes a capture token after a successful commit", () => {
    const task = prepareHostBrowserSearch("ligation", 1, emptyBase("ligation"));
    const capture = [{
      title: "Ligation protocol",
      url: "https://www.neb.com/en-us/protocols/ligation",
      html: "<main>valid</main>",
    }];
    commitHostBrowserSearch(task.captureId, capture);
    expect(() => commitHostBrowserSearch(task.captureId, capture)).toThrow("invalid or expired");
  });

  it("returns host-browser HTML exactly as captured", () => {
    const task = prepareHostBrowserSearch("ligation", 1, emptyBase("ligation"));
    const html = "  \n<main><h1>Ligation</h1></main>\n  ";
    const committed = commitHostBrowserSearch(task.captureId, [{
      title: " Ligation protocol ",
      url: "https://www.neb.com/en-us/protocols/ligation",
      html,
    }]);
    const id = committed.response.results[0]!.id;

    const fetched = fetchHostBrowserCapture(id)!;
    expect(fetched).toContain(`\n\n${html}\n\n_status: display-only-full-text_`);
  });
});
