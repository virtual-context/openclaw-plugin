import { describe, it, expect } from "vitest";

describe("vitest harness smoke", () => {
  it("loads vitest and runs a trivial assertion", () => {
    expect(1 + 1).toBe(2);
  });

  it("supports ESM imports natively", async () => {
    const mod = await import("../package.json", { with: { type: "json" } });
    expect(mod.default.name).toBe("openclaw-plugin-virtual-context");
    expect(mod.default.version).toBe("5.1.0");
  });
});
