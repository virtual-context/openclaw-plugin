/**
 * Heartbeat turns must never reach Virtual Context.
 *
 * User policy: machine-generated monitoring polls should not become canonical
 * turns, tags or segments. The exclusion is enforced at both network hooks -
 * prepare (before_prompt_build) and ingest (agent_end) - so a heartbeat turn
 * produces no VC traffic at all.
 *
 * Pinned in both directions deliberately: an exclusion that also swallowed real
 * turns would be a silent, total memory loss, which is worse than the volume
 * problem it solves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SESSION_KEY = "agent:bastkid-dedicated:main";

const createdHomes = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:os");
  for (const home of createdHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "vc-hb-test-"));
  mkdirSync(join(home, ".openclaw", "extensions", "virtual-context"), { recursive: true });
  const dir = join(home, ".openclaw", "agents", "bastkid-dedicated", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sessions.json"),
    JSON.stringify({ [SESSION_KEY]: { modelProvider: "openai", model: "gpt-5.6-sol" } }),
  );
  createdHomes.push(home);
  return home;
}

function installFetch() {
  const fetchSpy = vi.fn(async (url, options = {}) => {
    const body = JSON.parse(options.body ?? "{}");
    const payload = String(url).includes("/api/v1/context/ingest")
      ? { conversation_id: "conv", status: "ok" }
      : { conversation_id: "conv", body: { messages: body.messages ?? [] }, metadata: {} };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchSpy;
  return fetchSpy;
}

async function registerPlugin(home) {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual("node:os");
    return { ...actual, homedir: () => home };
  });
  const mod = await import("../index.js");
  const handlers = new Map();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const api = {
    logger: log,
    pluginConfig: { vcKey: "k", baseUrl: "https://api.example.com" },
    config: {},
    registerTool: vi.fn(),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  };
  mod.default.register(api);
  return { handlers, log };
}

function trackerPath(home) {
  return join(home, ".openclaw", "extensions", "virtual-context", "initialized-sessions.json");
}

function seedTracker(home) {
  const payload = JSON.stringify({ [SID]: { ingestedAt: "2026-01-01T00:00:00.000Z", messages: 7 } });
  writeFileSync(trackerPath(home), payload);
  return payload;
}

function readTrackerRaw(home) {
  const path = trackerPath(home);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

function vcCalls(fetchSpy) {
  return fetchSpy.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes("/api/v1/context/"));
}

const assistantTurn = {
  messages: [{ role: "assistant", content: [{ type: "text", text: "monitoring nominal" }] }],
};

describe("heartbeat exclusion", () => {
  it("a heartbeat turn produces no prepare and no ingest", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home);
    const ctx = { sessionId: SID, sessionKey: SESSION_KEY, trigger: "heartbeat" };

    await handlers.get("before_prompt_build")({ prompt: "heartbeat poll", messages: [] }, ctx);
    await handlers.get("agent_end")(assistantTurn, ctx);

    expect(vcCalls(fetchSpy)).toEqual([]);
  });

  it("a user turn still prepares and ingests", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home);
    const ctx = { sessionId: SID, sessionKey: SESSION_KEY, trigger: "user" };

    await handlers.get("before_prompt_build")({ prompt: "what did we decide?", messages: [] }, ctx);
    await handlers.get("agent_end")(assistantTurn, ctx);

    const calls = vcCalls(fetchSpy);
    expect(calls.some((url) => url.includes("/api/v1/context/prepare"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/v1/context/ingest"))).toBe(true);
  });

  it("a turn with no trigger is NOT excluded", async () => {
    // The host omits the key entirely for some triggers, so absence must never
    // be read as "heartbeat" - that would silently drop real turns.
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home);
    const ctx = { sessionId: SID, sessionKey: SESSION_KEY };

    await handlers.get("before_prompt_build")({ prompt: "hello", messages: [] }, ctx);
    await handlers.get("agent_end")(assistantTurn, ctx);

    expect(vcCalls(fetchSpy).length).toBeGreaterThan(0);
  });

  it("a heartbeat cannot reach the service via before_agent_reply", async () => {
    // A heartbeat whose text matched the VC command prefix would otherwise
    // POST to prepare, and a VCREINGEST-shaped one would reset the local
    // ingest tracker.
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home);
    const ctx = { sessionId: SID, sessionKey: SESSION_KEY, trigger: "heartbeat" };

    const seeded = seedTracker(home);

    for (const body of ["VCSTATUS", "VCREINGEST", "VCMERGE INTO x"]) {
      await handlers.get("before_agent_reply")({ cleanedBody: body, prompt: body }, ctx);
    }

    expect(vcCalls(fetchSpy)).toEqual([]);
    // Pins the ORDERING, not just the absence of network calls: VCREINGEST
    // resets this file locally before any request is made, so a guard placed
    // after that reset would still pass a network-only assertion.
    expect(readTrackerRaw(home)).toBe(seeded);
  });

  it("malformed or missing context is never treated as a heartbeat", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home);

    for (const ctx of [
      undefined,
      null,
      { sessionId: SID, sessionKey: SESSION_KEY, trigger: null },
      { sessionId: SID, sessionKey: SESSION_KEY, trigger: 0 },
      { sessionId: SID, sessionKey: SESSION_KEY, trigger: ["heartbeat"] },
      { sessionId: SID, sessionKey: SESSION_KEY, trigger: "HEARTBEAT" },
      { sessionId: SID, sessionKey: SESSION_KEY, trigger: " heartbeat" },
    ]) {
      const before = vcCalls(fetchSpy).length;
      await handlers.get("before_prompt_build")({ prompt: "real turn", messages: [] }, ctx);
      expect(
        vcCalls(fetchSpy).length,
        `ctx=${JSON.stringify(ctx)} must not be excluded`,
      ).toBeGreaterThan(before);
    }
  });

  it("cron and cli_budget turns are not excluded", async () => {
    // Only the heartbeat trigger is excluded. Widening it would quietly delete
    // memory of real scheduled work.
    for (const trigger of ["cron", "cli_budget"]) {
      const home = makeHome();
      const fetchSpy = installFetch();
      const { handlers } = await registerPlugin(home);
      const ctx = { sessionId: SID, sessionKey: SESSION_KEY, trigger };

      await handlers.get("before_prompt_build")({ prompt: "scheduled work", messages: [] }, ctx);
      await handlers.get("agent_end")(assistantTurn, ctx);

      expect(vcCalls(fetchSpy).length, `trigger=${trigger}`).toBeGreaterThan(0);
    }
  });
});
