import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SID1 = "11111111-2222-4333-8444-555555555555";
const SID2 = "22222222-3333-4444-8555-666666666666";
const STABLE_KEY = "agent:a:telegram:direct:42";
const STABLE_CONV_QS = "sk%3Aagent%3Aa%3Atelegram%3Adirect%3A42";
const DISCORD_GUILD = "1524917037191925871";
const DISCORD_CHANNEL = "1524946242499514418";
const DISCORD_SENDER = "387316537012518913";
const DISCORD_MESSAGE = "1529000000000000001";
const DISCORD_GROUP_KEY = `agent:vast:discord:guild:${DISCORD_GUILD}`;
const DISCORD_CHANNEL_KEY =
  `agent:vast:discord:channel:${DISCORD_CHANNEL}`;

function exactAdmission(owner = "conv") {
  return {
    version: 2,
    owner_conversation_id: owner,
    conversation_generation: 0,
    lifecycle_epoch: 1,
  };
}

const createdHomes = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    if (String(url).includes("/api/v1/context/capabilities")) {
      return new Response(JSON.stringify({
        exact_source_admission_version: 2,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = JSON.parse(options.body ?? "{}");
    let payload;
    if (String(url).includes("/api/v1/tools/")) {
      payload = { result: "tool ok" };
    } else if (String(url).includes("/api/v1/context/ingest")) {
      payload = { conversation_id: "conv", status: "ok" };
    } else if (body.messages?.some((message) => contentText(message.content).includes("VCSTATUS"))) {
      payload = { vc_command: "status", message: "status ok" };
    } else {
      payload = {
        conversation_id: "conv",
        body: { messages: body.messages ?? [] },
        metadata: {
          exact_source_admission_version: 2,
          exact_source_admission: exactAdmission(),
        },
      };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchSpy;
  return fetchSpy;
}

function continuityHash(role, content) {
  return createHash("sha256")
    .update(`${role}\0${content}`, "utf-8")
    .digest("hex");
}

function installContinuityFetch(prefixes) {
  let prepareIndex = 0;
  const fetchSpy = vi.fn(async (url, options = {}) => {
    const request = JSON.parse(options.body ?? "{}");
    if (String(url).includes("/api/v1/context/capabilities")) {
      return new Response(JSON.stringify({
        exact_source_admission_version: 2,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (
      !String(url).includes("/api/v1/context/prepare")
      && !String(url).includes("/api/v1/tools/__vc_exact_source_prepare_v2")
    ) {
      return new Response(
        JSON.stringify({ conversation_id: "conv", status: "ok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const prefix = prefixes[prepareIndex++];
    const prior = [
      {
        role: "user",
        content:
          `@Vast Keep replies concise and begin with “${prefix}:”.`,
      },
      { role: "assistant", content: `${prefix}: Understood.` },
    ];
    const active = request.messages.at(-1);
    const payload = {
      conversation_id: `sk:${DISCORD_GROUP_KEY}`,
      body: {
        messages: [
          {
            role: "system",
            content:
              "<system-reminder>VC actor cards and summaries</system-reminder>",
          },
          ...prior,
          active,
        ],
      },
      metadata: {
        exact_source_admission_version: 2,
        exact_source_admission: exactAdmission(`sk:${DISCORD_GROUP_KEY}`),
        recent_conversation_native: {
          message_count: prior.length,
          message_hashes: prior.map((message) =>
            continuityHash(message.role, message.content)),
        },
      },
    };
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
  const toolFactories = [];
  const commands = new Map();
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
    registerCommand: vi.fn((command) => commands.set(command.name, command)),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  };

  mod.default.register(api);
  return { handlers, toolFactories, commands, log };
}

function prepareEvent(prompt = "hello") {
  return { prompt, messages: [] };
}

function ctx(sessionId, sessionKey = STABLE_KEY) {
  return { sessionId, sessionKey, model: "openai-codex/gpt-5.5" };
}

function discordOpenClawConfig() {
  return {
    agents: {
      list: [{
        id: "vast",
        model: { primary: "openai/gpt-5.6-sol" },
        models: {
          "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
        },
      }],
    },
    bindings: [{
      agentId: "vast",
      match: { channel: "discord", accountId: "vast" },
    }],
    channels: {
      discord: {
        accounts: {
          vast: {
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

function discordSnowflakeTimestamp(messageId) {
  return Number((BigInt(messageId) >> 22n) + 1_420_070_400_000n);
}

describe("convIdentity hook routing", () => {
  it("keeps run-bound legacy completion ingestion for non-Discord groups", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers, log } = await registerPlugin(home);
    const runCtx = {
      sessionId: SID1,
      sessionKey: "agent:a:telegram:group:-5156869263",
      model: "openai-codex/gpt-5.5",
      runId: "telegram-run-1",
    };
    await handlers.get("before_prompt_build")(
      prepareEvent("Telegram group question"),
      runCtx,
    );
    await handlers.get("agent_end")({
      runId: runCtx.runId,
      success: true,
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "Telegram group reply" }],
      }],
    }, runCtx);
    await handlers.get("llm_output")({
      runId: runCtx.runId,
      sessionId: runCtx.sessionId,
      assistantTexts: ["Telegram group reply"],
      lastAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "Telegram group reply" }],
      },
    }, runCtx);

    const ingests = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/api/v1/context/ingest")
    );
    expect(ingests).toHaveLength(1);
    expect(JSON.parse(ingests[0][1].body)).toMatchObject({
      assistant_message: "Telegram group reply",
    });
    expect(log.error.mock.calls.some(([message]) =>
      String(message).includes("group completion lacks exact runId")
    )).toBe(false);
  });

  it("delivers and verifies Codex continuity on cold and warm turns", async () => {
    const home = makeHome();
    installContinuityFetch(["ColdBridge", "WarmBridge"]);
    const { handlers, log } = await registerPlugin(
      home,
      {
        convIdentity: "stable",
        conversationGroups: {
          [DISCORD_GROUP_KEY]: ["agent:vast:discord:channel:*"],
        },
      },
      discordOpenClawConfig(),
    );
    // The observer retains only a bounded per-run routing snapshot; it does
    // not prepare, ingest, or update actor cards for uninvoked messages.
    expect(handlers.has("message_received")).toBe(true);
    expect(handlers.has("before_dispatch")).toBe(true);

    for (const [index, prefix] of ["ColdBridge", "WarmBridge"].entries()) {
      const messageId = String(BigInt(DISCORD_MESSAGE) + BigInt(index));
      const requestBody = `@Vast Probe ${index + 1}`;
      const runCtx = {
        ...ctx(SID1, DISCORD_CHANNEL_KEY),
        model: "openai/gpt-5.6-sol",
        runId: `run-${index + 1}`,
      };
      const timestamp = discordSnowflakeTimestamp(messageId);
      handlers.get("message_received")({
        content: requestBody,
        timestamp,
        messageId,
        senderId: DISCORD_SENDER,
        metadata: {
          provider: "discord",
          originatingChannel: "discord",
          originatingTo: `channel:${DISCORD_CHANNEL}`,
          messageId,
          senderId: DISCORD_SENDER,
          senderName: "Optics",
          guildId: DISCORD_GUILD,
        },
      }, {
        channelId: "discord",
        accountId: "vast",
        conversationId: `channel:${DISCORD_CHANNEL}`,
        messageId,
        senderId: DISCORD_SENDER,
      });
      handlers.get("before_dispatch")({
        content: requestBody,
        body: requestBody,
        channel: "discord",
        sessionKey: DISCORD_CHANNEL_KEY,
        senderId: DISCORD_SENDER,
        timestamp,
      }, {
        channelId: "discord",
        accountId: "vast",
        conversationId: `channel:${DISCORD_CHANNEL}`,
        sessionKey: DISCORD_CHANNEL_KEY,
        senderId: DISCORD_SENDER,
      });
      await handlers.get("before_agent_reply")(
        { cleanedBody: requestBody },
        runCtx,
      );
      const event = prepareEvent(
        discordPrompt(requestBody).replace(DISCORD_MESSAGE, messageId),
      );
      const result = await handlers.get("before_prompt_build")(event, runCtx);

      expect(result).toHaveProperty("prependContext");
      expect(result).not.toHaveProperty("systemPrompt");
      expect(result.prependContext).toContain("<vc-prepared-context");
      expect(result.prependContext).toContain("<vc-conversation-continuity");
      expect(result.prependContext).toContain(`${prefix}:`);
      expect(event.messages).toHaveLength(1);

      handlers.get("llm_input")({
        provider: "openai",
        model: "gpt-5.6-sol",
        prompt: [
          "OpenClaw runtime context for this turn:",
          result.prependContext,
          discordPrompt(`@Vast Probe ${index + 1}`),
        ].join("\n\n"),
        historyMessages: event.messages,
      }, runCtx);
    }

    const messages = log.info.mock.calls.map(([message]) => message).join("\n");
    expect(messages).toContain("groupedSessions=1");
    expect(messages).toContain("runtime=codex");
    expect(messages).toContain("lane=per-turn-prompt");
    expect(messages.match(/adopted=true/g)).toHaveLength(2);
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

// Synthetic server/account identifiers: do not substitute deployment fixtures.
describe("BUG-001 server memory routing", () => {
  const server = "710000000000000001";
  const channel = "720000000000000001";
  const other = "720000000000000002";
  const channelKey = (id) => `agent:guide:discord:channel:${id}`;
  const serverConv = `sk:agent:guide:discord:guild:${server}`;
  const serverConfig = {
    bindings: [{ agentId: "guide", match: { channel: "discord", accountId: "primary" } }],
    channels: { discord: { accounts: { primary: {
      groupPolicy: "allowlist", guilds: { [server]: {}, "710000000000000002": {} },
    } } } },
  };
  function inbound(handlers, id, guildId = server) {
    handlers.get("message_received")({ content: "Synthetic message", metadata: {
      provider: "discord", guildId, originatingTo: `channel:${id}`,
    } }, { channelId: "discord", accountId: "primary", conversationId: `channel:${id}` });
  }
  it("routes tools from two channels to one server and forwards actual delivery channels", async () => {
    const fetchSpy = installFetch();
    const { handlers, toolFactories } = await registerPlugin(makeHome(), {
      convIdentity: "stable", discordMemoryScope: { guide: "server" },
    }, serverConfig);
    for (const id of [channel, other]) {
      inbound(handlers, id);
      const tool = toolFactories[0]({ sessionId: `session-${id}`, sessionKey: channelKey(id),
        messageChannel: "discord", agentAccountId: "primary", deliveryContext: { channel: "discord", to: `channel:${id}` } });
      await tool.execute(`tool-${id}`, { tag: "synthetic" });
    }
    const requests = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/tools/vc_expand_topic"));
    expect(requests).toHaveLength(2);
    for (const [index, [url]] of requests.entries()) {
      expect(new URL(url).searchParams.get("vcconv")).toBe(serverConv);
      expect(new URL(url).searchParams.get("vcchannel")).toBe([channel, other][index]);
    }
  });
  it("keeps prepare, exact completion, outbound capture and commands on the same route", async () => {
    const home = makeHome();
    const fetchSpy = vi.fn(async (url, options = {}) => {
      const href = String(url);
      const body = JSON.parse(options.body ?? "{}");
      let payload;
      if (href.includes("/context/capabilities")) payload = { exact_source_admission_version: 2 };
      else if (href.includes("__vc_exact_source_ingest_v2")) payload = {
        conversation_id: serverConv, status: "accepted", canonical_persisted: true,
        source_message_id: body.source_message_id,
      };
      else if (body.messages?.some(m => contentText(m.content) === "VCSTATUS")) payload = { vc_command: "status", message: "ok" };
      else payload = { conversation_id: serverConv, body: { messages: body.messages ?? [] }, metadata: {
        exact_source_admission_version: 2, exact_source_admission: exactAdmission(serverConv),
      } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    globalThis.fetch = fetchSpy;
    const { handlers, commands, log } = await registerPlugin(home, {
      convIdentity: "stable", discordMemoryScope: { guide: "server" }, outboundIdCapture: { mode: "carry" },
    }, serverConfig);
    const runs = [];
    for (const [i, id] of [channel, other].entries()) {
      const messageId = `74000000000000000${i + 1}`;
      const sender = `73000000000000000${i + 1}`;
      const content = `Synthetic channel question ${i + 1}`;
      const timestamp = discordSnowflakeTimestamp(messageId);
      const run = { sessionId: [SID1, SID2][i], sessionKey: channelKey(id), runId: `synthetic-run-${i + 1}` };
      runs.push(run);
      handlers.get("message_received")({ content, timestamp, messageId, senderId: sender, metadata: {
        provider: "discord", originatingChannel: "discord", originatingTo: `channel:${id}`,
        messageId, senderId: sender, senderName: `Participant ${i + 1}`, guildId: server,
      } }, { channelId: "discord", accountId: "primary", conversationId: `channel:${id}`, messageId, senderId: sender });
      handlers.get("before_dispatch")({ content, body: content, channel: "discord", sessionKey: run.sessionKey,
        senderId: sender, timestamp,
      }, { channelId: "discord", accountId: "primary", conversationId: `channel:${id}`, sessionKey: run.sessionKey, senderId: sender });
      await handlers.get("before_agent_reply")({ cleanedBody: content }, run);
      const prompt = `Conversation info (untrusted metadata):\n\`\`\`json\n${JSON.stringify({
        message_id: messageId, chat_id: `channel:${id}`, sender: { id: sender, name: `Participant ${i + 1}` },
        group_channel: "synthetic-room",
      })}\n\`\`\`\n\n${content}`;
      await handlers.get("before_prompt_build")({ prompt, messages: [] }, run);
      await handlers.get("message_sent")({ success: true, sessionKey: run.sessionKey,
        messageId: `75000000000000000${i + 1}`, content: `Synthetic reply ${i + 1}`,
      }, { channelId: "discord", accountId: "primary", conversationId: `channel:${id}`, sessionKey: run.sessionKey });
    }
    const prepares = fetchSpy.mock.calls.filter(([url]) => String(url).includes("__vc_exact_source_prepare_v2"));
    expect(prepares, log.warn.mock.calls.flat().join("\n")).toHaveLength(2);
    for (const [i, [url, options]] of prepares.entries()) {
      expect(new URL(url).searchParams.get("vcconv")).toBe(serverConv);
      expect(new URL(url).searchParams.get("vcchannel")).toBe([channel, other][i]);
      expect(JSON.parse(options.body).origin_channel_id).toBe([channel, other][i]);
    }
    // A later contradictory observation cannot move a previously prepared
    // invocation or its exact-source admission token into another scope.
    inbound(handlers, channel, "710000000000000002");
    for (const [i, run] of runs.entries()) {
      await handlers.get("agent_end")({ success: true, runId: run.runId, messages: [] }, run);
      await handlers.get("llm_output")({ runId: run.runId, sessionId: run.sessionId,
        assistantTexts: [`Synthetic reply ${i + 1}`], lastAssistant: { role: "assistant", content: `Synthetic reply ${i + 1}` },
      }, run);
    }
    const ingests = fetchSpy.mock.calls.filter(([url]) => String(url).includes("__vc_exact_source_ingest_v2"));
    expect(ingests, log.error.mock.calls.flat().join("\n")).toHaveLength(2);
    for (const [i, [url, options]] of ingests.entries()) {
      expect(new URL(url).searchParams.get("vcconv")).toBe(serverConv);
      const payload = JSON.parse(options.body);
      expect(payload.origin_channel_id).toBe([channel, other][i]);
      expect(payload.exact_source_admission.owner_conversation_id).toBe(serverConv);
      expect(payload._vc_agent_outbound_ids.some(item => item.channel_id === [channel, other][i])).toBe(true);
    }
    expect(await commands.get("vcstatus").handler({ sessionId: SID2, sessionKey: channelKey(other),
      channelId: "discord", accountId: "primary", conversationId: `channel:${other}` })).toHaveProperty("text");
    const command = fetchSpy.mock.calls.findLast(([url]) => String(url).includes("/context/prepare"));
    expect(new URL(command[0]).searchParams.get("vcconv")).toBe(serverConv);
    expect(new URL(command[0]).searchParams.get("vcchannel")).toBe(other);
    await commands.get("vcreingest").handler({ sessionId: SID2, sessionKey: channelKey(other) });
    expect(readTracker(home)[SID2]).toBeUndefined();
    expect(readTracker(home)[serverConv]).toBeUndefined();
  });

  it("uses native slash command fields and resets only the native session tracker", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers, commands } = await registerPlugin(home, {
      convIdentity: "stable", discordMemoryScope: { guide: "server" },
    }, serverConfig);
    inbound(handlers, channel);
    const sessionDir = join(home, ".openclaw", "agents", "guide", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "sessions.json"), JSON.stringify({
      [channelKey(channel)]: { sessionId: SID1 },
    }));
    writeFileSync(trackerPath(home), JSON.stringify({
      [SID1]: { lastIngestedTs: 10 }, [SID2]: { lastIngestedTs: 20 },
    }));
    const nativeContext = { channel: "discord", channelId: channel, accountId: "primary",
      sessionKey: channelKey(channel), from: `discord:channel:${channel}`, to: "slash:730000000000000001" };
    await commands.get("vcstatus").handler(nativeContext);
    const request = fetchSpy.mock.calls.find(([url]) => String(url).includes("/context/prepare"));
    expect(new URL(request[0]).searchParams.get("vcconv")).toBe(serverConv);
    expect(new URL(request[0]).searchParams.get("vcchannel")).toBe(channel);
    const result = await commands.get("vcreingest").handler(nativeContext);
    expect(result.text).toContain(SID1);
    expect(readTracker(home)[SID1]).toBeUndefined();
    expect(readTracker(home)[SID2]).toEqual({ lastIngestedTs: 20 });
  });

  it("keeps queued old completions on their original destination after server policy activation", async () => {
    const home = makeHome();
    const oldConv = `sk:${channelKey(channel)}`;
    const sourceMessage = "740000000000000001";
    const hash = value => createHash("sha256").update(value, "utf8").digest("hex");
    const vcKeyHash = hash("k");
    const deployment = hash(`https://api.example.com\0${vcKeyHash}`);
    const outboxKey = hash(`${deployment}\0${oldConv}\0${sourceMessage}`);
    const payload = { user_message: "Synthetic queued question", assistant_message: "Synthetic queued answer",
      source_message_id: sourceMessage, origin_channel_id: channel, exact_source_admission: exactAdmission(oldConv) };
    const record = { version: 2, deployment_id: deployment, base_url: "https://api.example.com", vc_key_hash: vcKeyHash,
      key: outboxKey, conv_id: oldConv, source_message_id: sourceMessage, enqueue_ordinal: 1,
      enqueued_at: new Date().toISOString(), payload, fingerprint: hash(JSON.stringify({ conv_id: oldConv, payload })) };
    const directory = join(home, ".openclaw", "state", "virtual-context", "completion-outbox", deployment);
    mkdirSync(directory, { recursive: true });
    const queuedPath = join(directory, `${outboxKey}.json`);
    writeFileSync(queuedPath, JSON.stringify(record));
    const fetchSpy = vi.fn(async (url) => {
      const result = String(url).includes("/capabilities") ? { exact_source_admission_version: 2 }
        : { status: "accepted", canonical_persisted: true, source_message_id: sourceMessage };
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    globalThis.fetch = fetchSpy;
    await registerPlugin(home, { convIdentity: "stable", discordMemoryScope: { guide: "server" } }, serverConfig);
    await vi.waitFor(() => expect(existsSync(queuedPath)).toBe(false));
    const delivered = fetchSpy.mock.calls.find(([url]) => String(url).includes("__vc_exact_source_ingest_v2"));
    expect(new URL(delivered[0]).searchParams.get("vcconv")).toBe(oldConv);
    expect(JSON.parse(delivered[1].body)).toEqual(payload);
  });

  it("resolves cold outbound membership through the same authenticated route lookup", async () => {
    const fetchSpy = vi.fn(async (url, options = {}) => {
      if (String(url).startsWith("https://discord.com/")) {
        expect(options.headers.Authorization).toBe("Bot synthetic-token");
        return new Response(JSON.stringify({ id: channel, guild_id: server }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    });
    globalThis.fetch = fetchSpy;
    const nativeConfig = structuredClone(serverConfig);
    nativeConfig.channels.discord.accounts.primary.token = "synthetic-token";
    const { handlers, toolFactories, log } = await registerPlugin(makeHome(), {
      convIdentity: "stable", discordMemoryScope: { guide: "server" }, outboundIdCapture: { mode: "observe" },
    }, nativeConfig);
    await handlers.get("message_sent")({ success: true, sessionKey: channelKey(channel),
      messageId: "750000000000000001", content: "Synthetic reply" }, {
      channelId: "discord", accountId: "primary", conversationId: `channel:${channel}`, sessionKey: channelKey(channel),
    });
    await toolFactories[0]({ sessionId: SID1, sessionKey: channelKey(channel), messageChannel: "discord",
      agentAccountId: "primary", deliveryContext: { to: `channel:${channel}` } }).execute("tool", {});
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).startsWith("https://discord.com/"))).toHaveLength(1);
    const tool = fetchSpy.mock.calls.find(([url]) => String(url).includes("/tools/vc_expand_topic"));
    expect(new URL(tool[0]).searchParams.get("vcconv")).toBe(serverConv);
    expect(log.info.mock.calls.flat().join("\n")).toContain("witnessed=1");
  });

  it("freezes tool credentials and routing context together", async () => {
    const home = makeHome();
    const otherKey = `vc-${"b".repeat(40)}`;
    const keyFile = join(home, "synthetic-secondary.key");
    writeFileSync(keyFile, otherKey);
    const fetchSpy = installFetch();
    const { handlers, toolFactories } = await registerPlugin(home, {
      convIdentity: "stable", discordMemoryScope: { guide: "server" }, agentKeyFiles: { secondary: keyFile },
    }, serverConfig);
    inbound(handlers, channel);
    const context = { sessionId: SID1, sessionKey: channelKey(channel), messageChannel: "discord",
      agentAccountId: "primary", deliveryContext: { to: `channel:${channel}` } };
    const tool = toolFactories[0](context);
    context.sessionKey = `agent:secondary:discord:channel:${other}`;
    context.sessionId = SID2;
    context.deliveryContext.to = `channel:${other}`;
    await tool.execute("tool", {});
    const request = fetchSpy.mock.calls.find(([url]) => String(url).includes("/tools/vc_expand_topic"));
    expect(new URL(request[0]).searchParams.get("vcconv")).toBe(serverConv);
    expect(new URL(request[0]).searchParams.get("vckey")).toBe("k");
    expect(new URL(request[0]).searchParams.get("vcchannel")).toBe(channel);
  });

  it("keeps legacy prepare URLs and main-session Discord DM access unchanged", async () => {
    const fetchSpy = installFetch();
    const { handlers, commands, toolFactories } = await registerPlugin(makeHome(), {
      convIdentity: "stable", discordMemoryScope: { guide: "server" },
    }, serverConfig);
    for (const sessionKey of ["agent:guide:main", "agent:guide:discord:direct:730000000000000001", "agent:other:telegram:direct:42"]) {
      const context = { sessionId: SID1, sessionKey, runId: `legacy-${sessionKey}`, agentId: sessionKey.split(":")[1],
        messageChannel: sessionKey.includes("telegram") ? "telegram" : "discord", channelId: sessionKey.includes("telegram") ? "telegram" : "discord" };
      await handlers.get("before_prompt_build")(prepareEvent("hello"), context);
      await toolFactories[0](context).execute("legacy", {});
    }
    // The actual native command shape uses a physical channelId.
    await commands.get("vcstatus").handler({ sessionId: SID2, sessionKey: `agent:other:discord:channel:${channel}`,
      channel: "discord", channelId: channel, accountId: "primary" });
    const prepares = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/context/prepare"));
    expect(prepares).toHaveLength(4);
    expect(prepares.every(([url]) => !new URL(url).searchParams.has("vcchannel"))).toBe(true);
    const tools = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/tools/vc_expand_topic"));
    expect(tools).toHaveLength(3);
    expect(new URL(tools[0][0]).searchParams.get("vcconv")).toBe("sk:agent:guide:main");
  });

  it("keeps the normalized outbound account when the native event owns it", async () => {
    installFetch();
    const nativeConfig = structuredClone(serverConfig);
    nativeConfig.bindings.push({ agentId: "guide", match: { channel: "discord", accountId: "secondary" } });
    nativeConfig.channels.discord.accounts.secondary = structuredClone(nativeConfig.channels.discord.accounts.primary);
    const { handlers, log } = await registerPlugin(makeHome(), {
      convIdentity: "stable", discordMemoryScope: { guide: "server" }, outboundIdCapture: { mode: "observe" },
    }, nativeConfig);
    inbound(handlers, channel);
    await handlers.get("message_sent")({ success: true, sessionKey: channelKey(channel), accountId: "primary",
      messageId: "750000000000000001", content: "Synthetic reply" }, {
      channelId: "discord", conversationId: `channel:${channel}`, sessionKey: channelKey(channel),
    });
    expect(log.info.mock.calls.flat().join("\n")).toContain("witnessed=1");
    expect(log.warn.mock.calls.flat().join("\n")).not.toContain("account_unknown");
  });

  it("preserves the exact prepare URL for a Discord agent outside the server policy", async () => {
    const fetchSpy = installFetch();
    const nativeConfig = structuredClone(serverConfig);
    nativeConfig.bindings.push({ agentId: "secondary", match: { channel: "discord", accountId: "primary" } });
    const { handlers } = await registerPlugin(makeHome(), {
      convIdentity: "stable", discordMemoryScope: { guide: "server" },
    }, nativeConfig);
    const nativeKey = `agent:secondary:discord:channel:${channel}`;
    const messageId = "740000000000000001";
    const senderId = "730000000000000001";
    const content = "Synthetic legacy channel question";
    const timestamp = discordSnowflakeTimestamp(messageId);
    const run = { sessionId: SID1, sessionKey: nativeKey, runId: "legacy-channel-run", agentId: "secondary",
      messageProvider: "discord", channelId: channel, accountId: "primary" };
    handlers.get("message_received")({ content, timestamp, messageId, senderId, metadata: {
      provider: "discord", guildId: server, originatingTo: `channel:${channel}`, messageId, senderId,
    } }, { channelId: "discord", accountId: "primary", conversationId: `channel:${channel}`, messageId, senderId });
    handlers.get("before_dispatch")({ content, body: content, channel: "discord", sessionKey: nativeKey, senderId, timestamp }, {
      channelId: "discord", accountId: "primary", conversationId: `channel:${channel}`, sessionKey: nativeKey, senderId,
    });
    await handlers.get("before_agent_reply")({ cleanedBody: content }, run);
    const prompt = `Conversation info (untrusted metadata):\n\`\`\`json\n${JSON.stringify({
      message_id: messageId, chat_id: `channel:${channel}`, sender: { id: senderId, name: "Synthetic participant" },
      group_channel: "synthetic-room",
    })}\n\`\`\`\n\n${content}`;
    await handlers.get("before_prompt_build")({ prompt, messages: [] }, run);
    const prepares = fetchSpy.mock.calls.filter(([url]) => String(url).includes("__vc_exact_source_prepare_v2"));
    expect(prepares).toHaveLength(1);
    const url = new URL(prepares[0][0]);
    expect(url.searchParams.get("vcconv")).toBe(`sk:${nativeKey}`);
    expect(url.searchParams.has("vcchannel")).toBe(false);
    expect(JSON.parse(prepares[0][1].body).origin_channel_id).toBe(channel);
  });

  it("does not interrupt inbound processing when native metadata is absent", async () => {
    installFetch();
    const { handlers } = await registerPlugin(makeHome(), {
      convIdentity: "stable", discordMemoryScope: { guide: "server" },
    }, serverConfig);
    expect(() => handlers.get("message_received")({ content: "Synthetic incomplete event" }, {
      channelId: "discord", accountId: "primary", conversationId: `channel:${channel}`,
    })).not.toThrow();
  });

  it("bypasses unresolved server memory instead of preparing a channel conversation", async () => {
    const fetchSpy = installFetch();
    const { handlers, toolFactories, log } = await registerPlugin(makeHome(), {
      convIdentity: "stable", discordMemoryScope: { guide: "server" },
    }, serverConfig);
    const run = { sessionId: SID1, sessionKey: channelKey(channel), runId: "scope-unavailable" };
    await handlers.get("before_prompt_build")(prepareEvent("hello"), run);
    const tool = toolFactories[0](run);
    expect((await tool.execute("missing", {})).content[0].text).toContain("memory scope unavailable");
    expect(fetchSpy.mock.calls.filter(([url]) => /context\/prepare|tools\/vc_/.test(String(url)))).toHaveLength(0);
    expect(log.warn.mock.calls.flat().join("\n")).toContain("membership_unknown");
  });
});
