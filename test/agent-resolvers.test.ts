import { describe, expect, it } from "vitest";
import { betterStatus, isVerifiedStatus, verificationFor } from "../src/agent/resolvers.ts";

describe("agent retrieval status semantics", () => {
  it("treats entitled and display-only bodies as verified full text", () => {
    expect(isVerifiedStatus("entitled-full-text")).toBe(true);
    expect(isVerifiedStatus("display-only-full-text")).toBe(true);
    expect(verificationFor("entitled-full-text")).toBe("verified");
    expect(verificationFor("display-only-full-text")).toBe("verified");
  });

  it("keeps a display-only browser link partial until its body is read", () => {
    expect(isVerifiedStatus("display-only-link")).toBe(false);
    expect(verificationFor("display-only-link")).toBe("partial");
    expect(betterStatus("display-only-link", "display-only-full-text")).toBe(
      "display-only-full-text",
    );
  });

  it("prefers openly licensed full text over more restricted full text", () => {
    expect(betterStatus("display-only-full-text", "ok")).toBe("ok");
    expect(betterStatus("entitled-full-text", "display-only-full-text")).toBe(
      "display-only-full-text",
    );
  });
});
