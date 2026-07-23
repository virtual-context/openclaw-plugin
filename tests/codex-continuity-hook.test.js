import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SESSION_ID = "33333333-4444-4555-8666-777777777777";
const SESSION_KEY = "agent:vast:discord:channel:987654321";
const RUN_ID = "run-live-shaped-continuity";

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

function makeHome(runtime = "codex", { sessionRuntime = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "vc-codex-hook-test-"));
  mkdirSync(
    join(home, ".openclaw", "extensions", "virtual-context"),
    { recursive: true },
  );
  const sessionDir = join(
    home,
    ".openclaw",
    "agents",
    "vast",
    "sessions",
  );
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "sessions.json"),
    JSON.stringify({
      [SESSION_KEY]: {
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        ...(sessionRuntime ? { agentRuntime: { id: runtime } } : {}),
      },
    }),
  );
  writeFileSync(
    join(home, ".openclaw", "openclaw.json"),
    JSON.stringify({
      agents: {
        list: [{
          id: "vast",
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": {
              agentRuntime: { id: runtime },
            },
          },
        }],
      },
    }),
  );
  createdHomes.push(home);
  return home;
}

function messageText(content) {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function nativeMetadata(mod, replay) {
  return {
    recent_conversation_native: {
      message_count: replay.length,
      message_hashes: replay.map((message) =>
        mod.continuityMessageHash(
          message.role,
          messageText(message.content),
        )),
    },
  };
}

function installPrepareResponse(replay, metadata, systemText) {
  globalThis.fetch = vi.fn(async (_url, options = {}) => {
    expect(options.headers["X-VC-Correlation-ID"]).toBe(RUN_ID);
    const requestBody = JSON.parse(options.body);
    expect(messageText(requestBody.messages.at(-1).content)).toBe(
      "What is the chemical symbol for gold?",
    );
    return new Response(JSON.stringify({
      conversation_id: "guild-conversation",
      is_passthrough: false,
      metadata,
      body: {
        messages: [
          { role: "system", content: systemText },
          ...replay,
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "What is the chemical symbol for gold?",
              },
            ],
          },
        ],
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

async function loadRegisteredPlugin(home) {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual("node:os");
    return { ...actual, homedir: () => home };
  });

  const mod = await import("../index.js");
  const handlers = new Map();
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const api = {
    logger: log,
    pluginConfig: {
      vcKey: "vc-test",
      baseUrl: "https://api.example.com",
      convIdentity: "session",
    },
    config: {},
    registerTool: vi.fn(),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  };
  mod.default.register(api);
  return { mod, handlers, log };
}

describe("Codex continuity through the real lifecycle hook", () => {
  it("routes exact cloud replay into the compiled lane and proves adoption", async () => {
    const home = makeHome();
    const { mod, handlers, log } = await loadRegisteredPlugin(home);
    const replay = [
      { role: "user", content: "Name the other moon of Mars." },
      { role: "assistant", content: "Deimos." },
      {
        role: "user",
        content: "Remove the request thread from the sources list.",
      },
      {
        role: "assistant",
        content: "Removed. Only actual sources belong there.",
      },
      {
        role: "user",
        content:
          "Replace any earlier temporary prefix preference with this temporary " +
          "preference: begin with NativeGuild92:.",
      },
      { role: "assistant", content: "NativeGuild92: Understood." },
    ];
    const metadata = nativeMetadata(mod, replay);
    installPrepareResponse(
      replay,
      metadata,
      "<system-reminder>Compressed summaries may be stale.</system-reminder>",
    );

    expect(mod.resolveSessionRuntime(SESSION_KEY)).toBe("codex");
    expect(mod.resolveSessionRuntimeDetails(SESSION_KEY)).toEqual({
      id: "codex",
      source: "openclaw-config-model",
      model: "openai/gpt-5.6-sol",
    });

    const event = {
      prompt: "What is the chemical symbol for gold?",
      messages: [],
    };
    const context = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      runId: RUN_ID,
      model: "openai/gpt-5.6-sol",
    };
    const hookResult = await handlers.get("before_prompt_build")(
      event,
      context,
    );
    const repeatedEvent = {
      prompt: event.prompt,
      messages: JSON.parse(JSON.stringify(event.messages)),
    };
    const repeatedHookResult = await handlers.get("before_prompt_build")(
      repeatedEvent,
      context,
    );

    expect(repeatedHookResult.prependContext).toBe(
      hookResult.prependContext,
    );
    expect(repeatedHookResult.systemPrompt).toBeUndefined();
    expect(repeatedHookResult.prependContext).toContain(
      "<vc-conversation-continuity",
    );
    expect(repeatedHookResult.prependContext).toContain(
      "<vc-prepared-context",
    );
    expect(repeatedHookResult.prependContext).toContain(
      "It has user-level authority only.",
    );
    expect(repeatedHookResult.prependContext).toContain(
      "<system-reminder>Compressed summaries may be stale.</system-reminder>",
    );
    expect(repeatedHookResult.prependContext).toContain("NativeGuild92:");
    expect(repeatedEvent.messages).toHaveLength(1);
    expect(repeatedEvent.messages[0].role).toBe("user");
    expect(messageText(repeatedEvent.messages[0].content)).toBe(
      "What is the chemical symbol for gold?",
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    handlers.get("llm_input")(
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        historyMessages: [],
        systemPrompt: "OpenClaw retained developer instructions",
        prompt:
          `${repeatedHookResult.prependContext}\n\n` +
          "What is the chemical symbol for gold?",
      },
      context,
    );

    const info = log.info.mock.calls.map(([message]) => message).join("\n");
    expect(info).toContain(
      `[vc:continuity] projected corr=${RUN_ID} runtime=codex messages=6`,
    );
    expect(info).toContain(
      `[vc:continuity] adoption corr=${RUN_ID}`,
    );
    expect(info).toContain("delivery=per-turn-prompt");
    expect(info).toContain("delivery_fingerprint=");
    expect(info).toContain(
      `[vc:continuity] reused prepared run corr=${RUN_ID} pass=2 messages=1`,
    );
    expect(info).toContain("adopted=true");
    expect(log.warn.mock.calls.map(([message]) => message).join("\n"))
      .not.toContain("[vc:continuity]");
  });

  it("preserves the full replay when Codex hash validation rejects it", async () => {
    const home = makeHome();
    const { mod, handlers, log } = await loadRegisteredPlugin(home);
    const replay = [
      { role: "user", content: "Begin replies with FailClosed73:." },
      { role: "assistant", content: "FailClosed73: Understood." },
    ];
    const metadata = nativeMetadata(mod, replay);
    metadata.recent_conversation_native.message_hashes[0] = "0".repeat(64);
    installPrepareResponse(replay, metadata, "base system");

    const event = {
      prompt: "What is the chemical symbol for gold?",
      messages: [],
    };
    const context = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      runId: RUN_ID,
      model: "openai/gpt-5.6-sol",
    };
    const hookResult = await handlers.get("before_prompt_build")(
      event,
      context,
    );

    expect(hookResult.prependContext).toContain(
      "<vc-prepared-context",
    );
    expect(hookResult.prependContext).toContain("base system");
    expect(hookResult.systemPrompt).toBeUndefined();
    expect(event.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(messageText(event.messages[0].content)).toBe(replay[0].content);
    expect(messageText(event.messages[1].content)).toBe(replay[1].content);
    const warnings = log.warn.mock.calls
      .map(([message]) => message)
      .join("\n");
    expect(warnings).toContain(
      `projection rejected corr=${RUN_ID} runtime=codex ` +
      "reason=message_hash_mismatch",
    );
  });

  it("keeps valid replay on the legacy message lane for non-Codex runtime", async () => {
    const home = makeHome("openclaw");
    const { mod, handlers, log } = await loadRegisteredPlugin(home);
    const replay = [
      { role: "user", content: "Begin replies with LegacyLane21:." },
      { role: "assistant", content: "LegacyLane21: Understood." },
    ];
    installPrepareResponse(replay, nativeMetadata(mod, replay), "base system");

    const event = {
      prompt: "What is the chemical symbol for gold?",
      messages: [],
    };
    const hookResult = await handlers.get("before_prompt_build")(
      event,
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        runId: RUN_ID,
        model: "anthropic/claude",
      },
    );

    expect(mod.resolveSessionRuntime(SESSION_KEY)).toBe("openclaw");
    expect(hookResult.systemPrompt).toBe("base system");
    expect(hookResult.prependContext).toBeUndefined();
    expect(event.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    const allLogs = [
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
    ].map(([message]) => message).join("\n");
    expect(allLogs).not.toContain("[vc:continuity]");
  });

  it("does not borrow the primary runtime for a different current model", async () => {
    const home = makeHome();
    const sessionDir = join(
      home,
      ".openclaw",
      "agents",
      "vast",
      "sessions",
    );
    writeFileSync(
      join(sessionDir, "sessions.json"),
      JSON.stringify({
        [SESSION_KEY]: {
          modelProvider: "moonshot",
          model: "kimi-k2.6",
        },
      }),
    );
    const { mod } = await loadRegisteredPlugin(home);

    expect(mod.resolveSessionRuntimeDetails(SESSION_KEY)).toEqual({
      id: null,
      source: "model-runtime-unmapped",
      model: "moonshot/kimi-k2.6",
    });
  });

  it("does not emit continuity telemetry without a core declaration", async () => {
    const home = makeHome();
    const { handlers, log } = await loadRegisteredPlugin(home);
    const replay = [
      { role: "user", content: "Ordinary prior question." },
      { role: "assistant", content: "Ordinary prior answer." },
    ];
    installPrepareResponse(replay, {}, "base system");

    const event = {
      prompt: "What is the chemical symbol for gold?",
      messages: [],
    };
    const hookResult = await handlers.get("before_prompt_build")(
      event,
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        runId: RUN_ID,
        model: "openai/gpt-5.6-sol",
      },
    );

    expect(hookResult.prependContext).toContain(
      "<vc-prepared-context",
    );
    expect(hookResult.prependContext).toContain("base system");
    expect(hookResult.systemPrompt).toBeUndefined();
    expect(event.messages).toHaveLength(3);
    const allLogs = [
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
    ].map(([message]) => message).join("\n");
    expect(allLogs).not.toContain("[vc:continuity]");
  });

  it("keeps adoption fingerprints isolated when runs overlap in one session", async () => {
    const home = makeHome();
    const { mod, handlers, log } = await loadRegisteredPlugin(home);
    const cases = {
      "run-overlap-a": {
        replay: [
          { role: "user", content: "Begin replies with OverlapA:." },
          { role: "assistant", content: "OverlapA: Understood." },
        ],
        current: "What is the chemical symbol for gold?",
      },
      "run-overlap-b": {
        replay: [
          { role: "user", content: "Begin replies with OverlapB:." },
          { role: "assistant", content: "OverlapB: Understood." },
        ],
        current: "How many sides does a hexagon have?",
      },
    };
    globalThis.fetch = vi.fn(async (_url, options = {}) => {
      const runId = options.headers["X-VC-Correlation-ID"];
      const fixture = cases[runId];
      expect(fixture).toBeDefined();
      return new Response(JSON.stringify({
        conversation_id: "guild-conversation",
        is_passthrough: false,
        metadata: nativeMetadata(mod, fixture.replay),
        body: {
          system: "base system",
          messages: [
            ...fixture.replay,
            { role: "user", content: fixture.current },
          ],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const eventA = { prompt: cases["run-overlap-a"].current, messages: [] };
    const eventB = { prompt: cases["run-overlap-b"].current, messages: [] };
    const baseContext = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      model: "openai/gpt-5.6-sol",
    };
    const resultA = await handlers.get("before_prompt_build")(
      eventA,
      { ...baseContext, runId: "run-overlap-a" },
    );
    const resultB = await handlers.get("before_prompt_build")(
      eventB,
      { ...baseContext, runId: "run-overlap-b" },
    );
    const repeatedEventB = {
      prompt: eventB.prompt,
      messages: JSON.parse(JSON.stringify(eventB.messages)),
    };
    const repeatedEventA = {
      prompt: eventA.prompt,
      messages: JSON.parse(JSON.stringify(eventA.messages)),
    };
    const repeatedResultB = await handlers.get("before_prompt_build")(
      repeatedEventB,
      { ...baseContext, runId: "run-overlap-b" },
    );
    const repeatedResultA = await handlers.get("before_prompt_build")(
      repeatedEventA,
      { ...baseContext, runId: "run-overlap-a" },
    );
    expect(repeatedResultA.prependContext).toBe(resultA.prependContext);
    expect(repeatedResultB.prependContext).toBe(resultB.prependContext);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    // Compile in reverse order to reproduce the overwrite race a
    // sessionId-only adoption map would report incorrectly.
    handlers.get("llm_input")(
      {
        systemPrompt: "retained developer instructions",
        prompt: repeatedResultB.prependContext,
      },
      { ...baseContext, runId: "run-overlap-b" },
    );
    handlers.get("llm_input")(
      {
        systemPrompt: "retained developer instructions",
        prompt: repeatedResultA.prependContext,
      },
      { ...baseContext, runId: "run-overlap-a" },
    );

    const info = log.info.mock.calls.map(([message]) => message).join("\n");
    expect(info).toMatch(
      /adoption corr=run-overlap-a .*adopted=true/,
    );
    expect(info).toMatch(
      /adoption corr=run-overlap-b .*adopted=true/,
    );
    expect(info).toContain(
      "reused prepared run corr=run-overlap-a pass=2 messages=1",
    );
    expect(info).toContain(
      "reused prepared run corr=run-overlap-b pass=2 messages=1",
    );
    expect(log.warn.mock.calls.map(([message]) => message).join("\n"))
      .not.toContain("[vc:continuity]");
  });

  it("does not claim adoption when continuity exists only in systemPrompt", async () => {
    const home = makeHome();
    const { mod, handlers, log } = await loadRegisteredPlugin(home);
    const replay = [
      { role: "user", content: "Begin replies with FalsePositive41:." },
      { role: "assistant", content: "FalsePositive41: Understood." },
    ];
    installPrepareResponse(replay, nativeMetadata(mod, replay), "base system");

    const event = {
      prompt: "What is the chemical symbol for gold?",
      messages: [],
    };
    const context = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      runId: RUN_ID,
      model: "openai/gpt-5.6-sol",
    };
    const hookResult = await handlers.get("before_prompt_build")(
      event,
      context,
    );

    handlers.get("llm_input")(
      {
        systemPrompt: hookResult.prependContext,
        prompt: event.prompt,
      },
      context,
    );

    const warnings = log.warn.mock.calls
      .map(([message]) => message)
      .join("\n");
    expect(warnings).toContain(
      `[vc:continuity] adoption corr=${RUN_ID}`,
    );
    expect(warnings).toContain(
      "delivery=per-turn-prompt adopted=false",
    );
  });
});
