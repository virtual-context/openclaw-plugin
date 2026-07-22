import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SID = "33333333-4444-4555-8666-777777777777";
const SESSION_KEY = "agent:vast:discord:guild:1524917037191925871";

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
  const home = mkdtempSync(join(tmpdir(), "vc-plugin-test-"));
  mkdirSync(join(home, ".openclaw", "extensions", "virtual-context"), { recursive: true });
  createdHomes.push(home);
  return home;
}

function installFetch() {
  const fetchSpy = vi.fn(async (url, options = {}) => {
    const payload = String(url).includes("/api/v1/context/ingest")
      ? { conversation_id: "conv", status: "ok" }
      : { conversation_id: "conv", body: { messages: [] }, metadata: {} };
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
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: { vcKey: "k", baseUrl: "https://api.example.com" },
    config: {},
    registerTool: vi.fn(),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  };
  mod.default.register(api);
  return handlers;
}

/** A native Discord reply whose typed body is only the bot mention. */
function replyOnlyPrompt() {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      message_id: "1527739552456773642",
      reply_to_id: "1527739528876654792",
      has_reply_context: true,
    }, null, 2),
    "```",
    "",
    "Reply target of current user message (untrusted, for context):",
    "```json",
    JSON.stringify({
      sender_label: "kidw.ai",
      body: "What reddits is the thots job pulling from",
    }, null, 2),
    "```",
    "",
    "<@1485681229608259666>",
  ].join("\n");
}

function ingestBodies(fetchSpy) {
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).includes("/api/v1/context/ingest"))
    .map(([, options]) => JSON.parse(options?.body ?? "{}"));
}

describe("reply-only invocation still records the turn", () => {
  it("sends the user half at ingest even though prepare is skipped", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const handlers = await registerPlugin(home);
    const ctx = { sessionId: SID, sessionKey: SESSION_KEY, model: "openai-codex/gpt-5.5" };

    const result = await handlers.get("before_prompt_build")(
      { prompt: replyOnlyPrompt(), messages: [] },
      ctx,
    );

    // The turn is deliberately not enriched: the host's reply-bearing prompt
    // stands and no prepare call is made.
    expect(result?.prependContext).toContain("Treat the replied-to message below");
    const prepareCalls = fetchSpy.mock.calls
      .filter(([url]) => String(url).includes("/api/v1/context/prepare"));
    expect(prepareCalls).toHaveLength(0);

    await handlers.get("agent_end")({
      messages: [{ role: "assistant", content: [{ type: "text", text: "r/steroids mostly." }] }],
    }, ctx);

    // Without a user half the completed-turn ingest is rejected as a fragment
    // and the answer is lost, so the user half must be present here.
    //
    // It carries the leading metadata envelope as well as the typed body. The
    // engine parses that envelope for sender, message id and reply target and
    // strips it from the stored text, so sending the body alone would store
    // the turn with nothing to attribute it to.
    const bodies = ingestBodies(fetchSpy);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].user_message).toContain("<@1485681229608259666>");
    expect(bodies[0].user_message).toContain("Conversation info (untrusted metadata)");
    expect(bodies[0].user_message).not.toContain("assembled context for this turn");
  });
});
