/**
 * The VC tool catalogue is one fixed list.
 *
 * Every session and every turn is offered byte-identical tool definitions,
 * and building them makes no network call. A definition that changed between
 * turns would change the head of the model request and discard the
 * provider's cached prompt prefix.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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

async function register() {
  const home = mkdtempSync(join(tmpdir(), "vc-tools-"));
  homes.push(home);
  vi.resetModules();
  vi.doMock("node:os", async (orig) => ({ ...(await orig()), homedir: () => home }));
  const mod = await import("../index.js");
  const factories = [];
  mod.default.register({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: { vcKey: "k", baseUrl: "https://api.example.com" },
    config: {},
    registerTool: vi.fn((factory) => factories.push(factory)),
    registerCommand: vi.fn(),
    on: vi.fn(),
  });
  return factories;
}

const view = (tool) => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });

describe("fixed tool catalogue", () => {
  it("offers identical definitions to every session without a network call", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy;
    const factories = await register();
    const dm = factories.map((f) => view(f({ sessionKey: "agent:bast:telegram:direct:1", sessionId: "s1" })));
    const group = factories.map((f) => view(f({ sessionKey: "agent:bast:telegram:group:-2", sessionId: "s2" })));
    const again = factories.map((f) => view(f({ sessionKey: "agent:bast:telegram:direct:1", sessionId: "s1" })));
    expect(dm).toHaveLength(7);
    expect(group).toEqual(dm);
    expect(again).toEqual(dm);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
