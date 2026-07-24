import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SID1 = "11111111-2222-4333-8444-555555555555";
const SID2 = "22222222-3333-4444-8555-666666666666";
const STABLE_KEY = "agent:a:telegram:direct:42";
const STABLE_CONV_QS = "sk%3Aagent%3Aa%3Atelegram%3Adirect%3A42";
const DISCORD_GUILD = "1524917037191925871";
const DISCORD_CHANNEL = "1524946242499514418";
const DISCORD_BOT = "1485681229608259666";
const DISCORD_SENDER = "387316537012518913";
const DISCORD_MESSAGE = "1529000000000000001";
const DISCORD_GROUP_KEY = `agent:vast:discord:guild:${DISCORD_GUILD}`;
const DISCORD_CHANNEL_KEY =
  `agent:vast:discord:channel:${DISCORD_CHANNEL}`;

const createdHomes = [];
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
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

function writeSessionJsonl(home, agentId, sessionId, messages) {
  const dir = join(home, ".openclaw", "agents", agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  const lines = messages.map((message) => JSON.stringify({ message })).join("\n");
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines}\n`);
}

function writeSessionsStore(home, agentId, sessionKey, provider, model) {
  const dir = join(home, ".openclaw", "agents", agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sessions.json"),
    JSON.stringify({
      [sessionKey]: { modelProvider: provider, model },
    }),
  );
}

function trackerPath(home) {
  return join(home, ".openclaw", "extensions", "virtual-context", "initialized-sessions.json");
}

function readTracker(home) {
  const path = trackerPath(home);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => block?.text ?? "").join("\n");
  }
  return "";
}

function installFetch() {
  const fetchSpy = vi.fn(async (url, options = {}) => {
    const body = JSON.parse(options.body ?? "{}");
    let payload;
    if (String(url).includes("/api/v1/tools/")) {
      payload = { result: "tool ok" };
    } else if (String(url).includes("/api/v1/context/ingest")) {
      payload = { conversation_id: "conv", status: "ok" };
    } else if (body.messages?.some((message) => contentText(message.content).includes("VCSTATUS"))) {
      payload = { vc_command: "status", message: "status ok" };
    } else {
      payload = { conversation_id: "conv", body: { messages: body.messages ?? [] }, metadata: {} };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchSpy;
  return fetchSpy;
}

async function registerPlugin(home, pluginConfig = {}, openClawConfig = {}) {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual("node:os");
    return { ...actual, homedir: () => home };
  });

  const mod = await import("../index.js");
  const handlers = new Map();
  const services = new Map();
  const toolFactories = [];
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const api = {
    logger: log,
    pluginConfig: {
      vcKey: "k",
      baseUrl: "https://api.example.com",
      ...pluginConfig,
    },
    config: openClawConfig,
    registerTool: vi.fn((factory) => toolFactories.push(factory)),
    registerService: vi.fn((service) => services.set(service.id, service)),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  };

  mod.default.register(api);
  return { handlers, services, toolFactories, log };
}

function prepareEvent(prompt = "hello") {
  return { prompt, messages: [] };
}

function ctx(sessionId, sessionKey = STABLE_KEY) {
  return { sessionId, sessionKey, model: "openai-codex/gpt-5.5" };
}

function discordOpenClawConfig() {
  return {
    bindings: [{
      agentId: "vast",
      match: { channel: "discord", accountId: "vast" },
    }],
    channels: {
      discord: {
        accounts: {
          vast: {
            token: "test-discord-token",
            groupPolicy: "allowlist",
            guilds: {
              [DISCORD_GUILD]: {
                channels: { "*": { enabled: true } },
              },
            },
          },
        },
      },
    },
  };
}

class FakeGatewaySocket {
  static instances = [];

  constructor() {
    this.readyState = 1;
    this.listeners = new Map();
    FakeGatewaySocket.instances.push(this);
  }

  addEventListener(name, handler) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(handler);
    this.listeners.set(name, listeners);
  }

  send() {}

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const handler of this.listeners.get("close") ?? []) {
      handler({ code });
    }
  }

  gateway(payload) {
    for (const handler of this.listeners.get("message") ?? []) {
      handler({ data: JSON.stringify(payload) });
    }
  }
}

function discordPrompt(content) {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      message_id: DISCORD_MESSAGE,
      chat_id: `channel:${DISCORD_CHANNEL}`,
      sender: { id: DISCORD_SENDER, name: "Optics" },
      group_channel: "vasttest",
    }, null, 2),
    "```",
    "",
    content,
  ].join("\n");
}

describe("convIdentity hook routing", () => {
  it("lets prompt-build veto an invocation before ambient delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T20:28:30.000Z"));
    FakeGatewaySocket.instances = [];
    globalThis.WebSocket = FakeGatewaySocket;
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers, services, log } = await registerPlugin(home, {
      convIdentity: "stable",
      conversationGroups: {
        [DISCORD_GROUP_KEY]: ["agent:vast:discord:channel:*"],
      },
      observeGuildMessages: true,
      observeBotUserId: DISCORD_BOT,
      observeDiscordAccountId: "vast",
      observeFallbackDelayMs: 1000,
    }, discordOpenClawConfig());
    const content = "Vast what do you think about amber herons";
    const service = services.get("virtual-context-discord-observer");
    service.start();
    const socket = FakeGatewaySocket.instances[0];
    socket.gateway({
      op: 10,
      d: { heartbeat_interval: 1_000_000 },
    });
    socket.gateway({
      op: 0,
      s: 1,
      t: "READY",
      d: {
        user: { id: DISCORD_BOT },
        session_id: "session-1",
        resume_gateway_url: "wss://resume.discord.gg",
      },
    });
    socket.gateway({
      op: 0,
      s: 2,
      t: "MESSAGE_CREATE",
      d: {
        id: DISCORD_MESSAGE,
        guild_id: DISCORD_GUILD,
        channel_id: DISCORD_CHANNEL,
        content,
        timestamp: "2026-07-23T20:28:00.000Z",
        author: {
          id: DISCORD_SENDER,
          username: "optics",
          global_name: "Optics",
          bot: false,
        },
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    await handlers.get("before_prompt_build")({
      prompt: discordPrompt(content),
      messages: [],
    }, {
      sessionId: SID1,
      sessionKey: DISCORD_CHANNEL_KEY,
      model: "openai-codex/gpt-5.5",
    });
    await vi.advanceTimersByTimeAsync(1000);

    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes("/context/observe"))).toEqual([]);
    expect(urls.filter((url) => url.includes("/context/prepare"))).toHaveLength(1);
    expect(log.info.mock.calls.map(([message]) => message).join("\n"))
      .toContain("cancelled by prompt invocation");
    service.stop();
  });

  it("stable mode routes prepare, ingest, and tools through the selected conv id", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers, toolFactories, log } = await registerPlugin(home, {
      convIdentity: "stable",
      debug: true,
    });

    await handlers.get("before_prompt_build")(prepareEvent(), ctx(SID1));
    await handlers.get("agent_end")({
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    }, ctx(SID1));
    const tool = toolFactories[0](ctx(SID1));
    await tool.execute("call-1", { tag: "x" });

    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toBe(
      `https://api.example.com/api/v1/context/prepare?vckey=k&vcconv=${STABLE_CONV_QS}&predecessor=${SID1}`,
    );
    expect(urls[1]).toBe(
      `https://api.example.com/api/v1/context/ingest?vckey=k&vcconv=${STABLE_CONV_QS}`,
    );
    expect(urls[2]).toContain(`/api/v1/tools/`);
    expect(urls[2]).toContain(`vcconv=${STABLE_CONV_QS}`);
    expect(urls[2]).not.toContain("predecessor=");

    const debugPrepareLogs = log.info.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes("[vc:debug] prepare request"));
    expect(debugPrepareLogs.some((message) => message.includes(`vcconv=sk:${STABLE_KEY}`))).toBe(true);
    expect(debugPrepareLogs.some((message) => message.includes(`vcconv=${SID1}`))).toBe(false);
  });

  it("session mode keeps the legacy URL shape and emits no fallback warning", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers, log } = await registerPlugin(home, { convIdentity: "session" });

    await handlers.get("before_prompt_build")(prepareEvent(), ctx(SID1));

    expect(fetchSpy.mock.calls[0][0]).toBe(
      `https://api.example.com/api/v1/context/prepare?vckey=k&vcconv=${SID1}`,
    );
    expect(fetchSpy.mock.calls[0][0]).not.toContain("predecessor=");
    expect(log.warn.mock.calls.map(([message]) => message).join("\n"))
      .not.toContain("ephemeral conv-id fallback");
  });

  it("invalid convIdentity resolves to session mode with one config warning", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers, log } = await registerPlugin(home, { convIdentity: "bogus" });

    await handlers.get("before_prompt_build")(prepareEvent(), ctx(SID1));

    expect(fetchSpy.mock.calls[0][0]).toBe(
      `https://api.example.com/api/v1/context/prepare?vckey=k&vcconv=${SID1}`,
    );
    const warnings = log.warn.mock.calls.map(([message]) => message);
    expect(warnings.filter((message) => message.includes("convIdentity="))).toHaveLength(1);
    expect(warnings.join("\n")).not.toContain("ephemeral conv-id fallback");
  });

  it("warns only missing and unparseable stable-mode fallbacks", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers, log } = await registerPlugin(home, { convIdentity: "stable" });
    const prepare = handlers.get("before_prompt_build");

    await prepare(prepareEvent(), { sessionId: SID1 });
    await prepare(prepareEvent(), { sessionId: SID2, sessionKey: "agent:a:matrix:room:abc" });
    await prepare(prepareEvent(), { sessionId: "subagent-session", sessionKey: "agent:a:subagent:spawn" });
    await prepare(prepareEvent(), { sessionId: "explicit-session", sessionKey: "agent:a:explicit:explicit-session" });

    const fallbackWarnings = log.warn.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes("ephemeral conv-id fallback"));
    expect(fallbackWarnings).toHaveLength(2);
    expect(fallbackWarnings[0]).toContain("missing_session_key");
    expect(fallbackWarnings[0]).toContain("count=1");
    expect(fallbackWarnings[1]).toContain("unparseable_session_key");
    expect(fallbackWarnings[1]).toContain("count=2");
    for (const [url] of fetchSpy.mock.calls) {
      expect(String(url)).not.toContain("predecessor=");
    }
  });

  it("keeps the ingest tracker sessionId-keyed, including VCREINGEST replay", async () => {
    const home = makeHome();
    writeSessionJsonl(home, "a", SID1, [
      { role: "user", content: "old 1" },
      { role: "assistant", content: "old 2" },
    ]);
    writeSessionJsonl(home, "a", SID2, [
      { role: "user", content: "old a" },
      { role: "assistant", content: "old b" },
    ]);

    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, { convIdentity: "stable" });
    const prepare = handlers.get("before_prompt_build");

    await prepare(prepareEvent("new 1"), ctx(SID1));
    await prepare(prepareEvent("new 2"), ctx(SID2));

    let tracker = readTracker(home);
    expect(Object.keys(tracker).sort()).toEqual([SID1, SID2].sort());
    expect(tracker).not.toHaveProperty(`sk:${STABLE_KEY}`);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).messages).toHaveLength(3);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body).messages).toHaveLength(3);

    await prepare(prepareEvent("VCREINGEST"), ctx(SID1));
    tracker = readTracker(home);
    expect(tracker).not.toHaveProperty(SID1);
    expect(tracker).toHaveProperty(SID2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await prepare(prepareEvent("new 1 again"), ctx(SID1));

    tracker = readTracker(home);
    expect(Object.keys(tracker).sort()).toEqual([SID1, SID2].sort());
    expect(fetchSpy.mock.calls[2][0]).toBe(
      `https://api.example.com/api/v1/context/prepare?vckey=k&vcconv=${STABLE_CONV_QS}&predecessor=${SID1}`,
    );
    expect(JSON.parse(fetchSpy.mock.calls[2][1].body).messages).toHaveLength(3);
  });

  it("keeps VC-command ingest skip state scoped to sessionId", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, { convIdentity: "stable" });

    await handlers.get("before_prompt_build")(prepareEvent("VCSTATUS"), ctx(SID1));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await handlers.get("agent_end")({
      messages: [{ role: "assistant", content: [{ type: "text", text: "sid2 done" }] }],
    }, ctx(SID2));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toContain("/api/v1/context/ingest");

    await handlers.get("agent_end")({
      messages: [{ role: "assistant", content: [{ type: "text", text: "sid1 done" }] }],
    }, ctx(SID1));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("provider-filter transition warnings do not trigger identity fallback warnings", async () => {
    const home = makeHome();
    writeSessionsStore(home, "a", STABLE_KEY, "openai-codex", "gpt-5.5");
    const fetchSpy = installFetch();
    const { handlers, log } = await registerPlugin(home, {
      convIdentity: "stable",
      providers: ["openai-codex/gpt-5.5"],
    });

    await handlers.get("before_prompt_build")(prepareEvent(), ctx(SID1));
    writeSessionsStore(home, "a", STABLE_KEY, "minimax", "m2.7");
    await handlers.get("before_prompt_build")(prepareEvent("skipped"), ctx(SID1));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const warnings = log.warn.mock.calls.map(([message]) => message).join("\n");
    expect(warnings).toContain("provider filter now SKIPPING");
    expect(warnings).not.toContain("ephemeral conv-id fallback");
  });
});
