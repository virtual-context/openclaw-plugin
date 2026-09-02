/**
 * The contextTokens startup warning, inverted.
 *
 * The old warning fired whenever agents.defaults.contextTokens was below
 * one million and recommended "2000000+". That advice predates per-turn
 * ingest: it inflated resolved context budgets so far past any real model
 * window that the gateway's compaction triggers could never fire before a
 * native harness limit did — observed live as a self-sustaining
 * reset loop on a codex lane (five resets an hour, tightening). VC loses
 * nothing to early compaction: every turn is ingested at agent_end and
 * compaction summaries are preserved by the history limiter.
 *
 * New rule: warn in the OPPOSITE direction — an inflated budget is the
 * hazard, not a modest one.
 */
import { describe, it, expect } from "vitest";
import { contextTokensWarning } from "../index.js";

describe("contextTokensWarning", () => {
  it("stays quiet for absent or non-numeric values", () => {
    for (const v of [undefined, null, "2000000", {}]) {
      expect(contextTokensWarning(v)).toBe(null);
    }
  });

  it("stays quiet for modest, truthful budgets (the old warning is gone)", () => {
    for (const v of [128000, 200000, 372000, 1000000, 2000000]) {
      expect(contextTokensWarning(v)).toBe(null);
    }
  });

  it("warns when the budget exceeds any real model window", () => {
    for (const v of [2000001, 20000000]) {
      const warning = contextTokensWarning(v);
      expect(warning).toBeTruthy();
      expect(warning).toContain(String(v));
      expect(warning.toLowerCase()).toContain("compaction");
    }
  });

  it("never recommends inflating the budget", () => {
    const warning = contextTokensWarning(20000000) ?? "";
    expect(warning).not.toContain("2000000+");
    expect(warning.toLowerCase()).not.toContain("recommend 2000000");
  });
});
