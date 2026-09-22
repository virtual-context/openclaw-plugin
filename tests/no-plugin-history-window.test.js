/** The plugin never asks the host to project less history: trimming is VC's job on the outbound payload. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("host projection stays whole", () => {
  it("index.js registers the context engine without a history window", () => {
    const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    expect(src.includes("historyWindowFor:")).toBe(false);
  });
});
