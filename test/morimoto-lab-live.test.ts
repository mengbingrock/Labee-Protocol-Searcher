import { expect, it } from "vitest";
import { search } from "../src/search.ts";
import { fetchResource } from "../src/fetch.ts";

it.skipIf(process.env.LABEE_LIVE_MORIMOTO !== "1")("searches the live Morimoto catalog and reads a protocol PDF", async () => {
  await import("../src/env.ts");
  const response = await search("PCR", { sources: ["morimoto-lab"], limit: 4 });
  expect(response.sources[0]?.route).toBe("morimoto-lab-catalog");
  expect(response.results.length).toBeGreaterThan(0);
  console.log(JSON.stringify(response.results.map(({ title, id }) => ({ title, id }))));
  const selected = response.results.find(row => /polymerase chain reaction/i.test(row.title)) ?? response.results[0]!;
  const content = await fetchResource(selected.id);
  expect(content).toContain("status: ok");
  expect(content.length).toBeGreaterThan(400);
  expect(content).toMatch(/polymerase|PCR|DNA/i);
  console.log(JSON.stringify({ title: selected.title, fetchedChars: content.length }));
}, 90_000);
