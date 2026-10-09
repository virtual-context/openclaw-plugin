/**
 * Fetched VC tool definitions survive a gateway restart.
 *
 * The tool factory is synchronous, so a turn that arrives before the fetch
 * completes is served from the cache. Without a saved copy, every restart
 * served the hardcoded set on its first turn and the fetched set afterwards,
 * so the tool catalog the model sees changed from turn to turn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
const homes = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:os");
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function loadPlugin(home) {
  vi.resetModules();
  vi.doMock("node:os", async (orig) => ({ ...(await orig()), homedir: () => home }));
  return import("../index.js");
}

const FETCHED = {
  name: "vc_find_quote",
  description: "Find direct quote-like evidence from raw conversation turns.",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

describe("tool definition persistence", () => {
  it("serves the last fetched definitions after a restart, before any fetch completes", async () => {
    const home = mkdtempSync(join(tmpdir(), "vc-tooldefs-"));
    homes.push(home);

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ tools: [FETCHED] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    const first = await loadPlugin(home);
    first.maybeRefreshToolDefs("https://vc.test", "vc-key", "conv-1", "chan");
    await vi.waitFor(() => expect(first.cachedToolDef("conv-1", "vc_find_quote", "chan")).toEqual(FETCHED));
    await vi.waitFor(() => expect(existsSync(join(home, ".openclaw", "state", "virtual-context", "tool-definitions.json"))).toBe(true));

    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    const restarted = await loadPlugin(home);
    expect(restarted.cachedToolDef("conv-1", "vc_find_quote", "chan")).toEqual(FETCHED);
    expect(restarted.cachedToolDef("conv-2", "vc_find_quote", "chan")).toBeUndefined();
  });

  it("refreshes saved definitions instead of treating them as current", async () => {
    const home = mkdtempSync(join(tmpdir(), "vc-tooldefs-"));
    homes.push(home);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ tools: [FETCHED] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    const first = await loadPlugin(home);
    first.maybeRefreshToolDefs("https://vc.test", "vc-key", "conv-1", "");
    await vi.waitFor(() => expect(first.cachedToolDef("conv-1", "vc_find_quote", "")).toEqual(FETCHED));
    await vi.waitFor(() => expect(existsSync(join(home, ".openclaw", "state", "virtual-context", "tool-definitions.json"))).toBe(true));

    const fetchSpy = vi.fn(() => new Promise(() => {}));
    globalThis.fetch = fetchSpy;
    const restarted = await loadPlugin(home);
    restarted.maybeRefreshToolDefs("https://vc.test", "vc-key", "conv-1", "");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
