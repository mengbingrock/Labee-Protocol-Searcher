import { describe, expect, it } from "vitest";
import { isVerifiedStatus } from "../src/agent/resolvers.ts";

describe("agent retrieval status semantics", () => {
  it("treats entitled and display-only bodies as verified full text", () => {
    expect(isVerifiedStatus("entitled-full-text")).toBe(true);
    expect(isVerifiedStatus("display-only-full-text")).toBe(true);
  });

  it("does not treat links and abstracts as full text", () => {
    expect(isVerifiedStatus("display-only-link")).toBe(false);
    expect(isVerifiedStatus("abstract-only")).toBe(false);
    expect(isVerifiedStatus("oa-link")).toBe(false);
  });
});
