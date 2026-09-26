import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VENDOR_IDS } from "../src/vendors.ts";

const skillsRoot = new URL(
  "../plugins/labee-protocol-searcher/skills/",
  import.meta.url,
);

describe("Codex plugin source selectors", () => {
  it("exposes one toggleable skill for every searchable source", () => {
    const expected = [...VENDOR_IDS, "rebase"].sort();
    const actual = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("labee-source-"))
      .map((entry) => entry.name.slice("labee-source-".length))
      .sort();

    expect(actual).toEqual(expected);
  });

  it.each([...VENDOR_IDS, "rebase"])("declares the %s source id and UI metadata", (source) => {
    const root = new URL(`labee-source-${source}/`, skillsRoot);
    const skill = readFileSync(new URL("SKILL.md", root), "utf8");
    const metadata = readFileSync(new URL("agents/openai.yaml", root), "utf8");

    expect(skill).toContain(`source id \`${source}\``);
    expect(skill).toContain(`Contribute \`${source}\``);
    expect(metadata).toContain("display_name:");
    expect(metadata).toContain("short_description:");
  });
});
