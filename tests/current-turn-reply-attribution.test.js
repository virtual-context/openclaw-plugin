import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SESSION_ID = "56ec9929-ee2e-4657-8e20-079f98a702e8";
const RUN_ID = "c08c9e71-550b-4a90-8f9b-fc7cb11db6a5";
const OTHER_SESSION_ID = "bf99cdb3-8b6c-43d5-8b1f-87703f076ed8";
const OTHER_RUN_ID = "d902f88b-0596-4393-9858-862275472bbc";
const CHANNEL_ID = "1529892355141013684";
const SESSION_KEY = `agent:vast:discord:channel:${CHANNEL_ID}`;
const OTHER_SESSION_KEY = `agent:bast:discord:channel:${CHANNEL_ID}`;
const CURRENT_MESSAGE_ID = "1532432883887767746";
const TARGET_MESSAGE_ID = "1532423627536863272";
const CURRENT_SENDER_ID = "940968368398270464";
const VAST_ID = "1485681229608259666";
const CURRENT_BODY = "Cant fool me with your reverse-psychology";
const TARGET_BODY = "No. Keep the reality check.";

function exactAdmission(owner = "conv") {
  return {
    version: 2,
    owner_conversation_id: owner,
    conversation_generation: 0,
    lifecycle_epoch: 1,
  };
}

function snowflakeTimestamp(messageId) {
  return Number((BigInt(messageId) >> 22n) + 1_420_070_400_000n);
}

const CURRENT_TIMESTAMP = snowflakeTimestamp(CURRENT_MESSAGE_ID);

const originalFetch = globalThis.fetch;
const homes = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:os");
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "vc-current-reply-"));
  mkdirSync(
    join(home, ".openclaw", "extensions", "virtual-context"),
    { recursive: true },
  );
  homes.push(home);
  return home;
}

function textOf(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
    : "";
}

function isPrepareHref(href) {
  return href.includes("/api/v1/context/prepare")
    || href.includes("/tools/__vc_exact_source_prepare_v2");
}

function isIngestHref(href) {
  return href.includes("/api/v1/context/ingest")
    || href.includes("/tools/__vc_exact_source_ingest_v2");
}

function installFetch({
  targetEditedTimestamp = null,
  expectedDiscordTokens = ["Bot vast-discord-token"],
} = {}) {
  const calls = [];
  let discordCallIndex = 0;
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, options });
    if (href.includes("/api/v1/context/capabilities")) {
      return new Response(JSON.stringify({
        exact_source_admission_version: 2,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (href.startsWith("https://discord.com/api/")) {
      expect(options.headers.Authorization).toBe(
        expectedDiscordTokens[discordCallIndex],
      );
      discordCallIndex += 1;
      return new Response(JSON.stringify({
        id: CURRENT_MESSAGE_ID,
        channel_id: CHANNEL_ID,
        content: CURRENT_BODY,
        timestamp: new Date(CURRENT_TIMESTAMP).toISOString(),
        author: { id: CURRENT_SENDER_ID, username: "sendnewds" },
        message_reference: {
          type: 0,
          channel_id: CHANNEL_ID,
          message_id: TARGET_MESSAGE_ID,
        },
        referenced_message: {
          id: TARGET_MESSAGE_ID,
          channel_id: CHANNEL_ID,
          content: TARGET_BODY,
          timestamp: new Date(snowflakeTimestamp(TARGET_MESSAGE_ID)).toISOString(),
          edited_timestamp: targetEditedTimestamp,
          author: { id: VAST_ID, username: "Vast", global_name: "Vast" },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const request = JSON.parse(options.body ?? "{}");
    const payload = isIngestHref(href)
      ? {
          conversation_id: "conv",
          status: "accepted",
          canonical_persisted: true,
          source_message_id: (
            request.source_attestation?.message_id
            ?? request.source_message_id
            ?? ""
          ),
        }
      : {
          conversation_id: "conv",
          body: { messages: request.messages ?? [] },
          metadata: {
            exact_source_admission_version: 2,
            exact_source_admission: exactAdmission(),
          },
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

async function registerPlugin(home, { bindings, pluginConfig } = {}) {
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
    pluginConfig: {
      vcKey: "k",
      baseUrl: "https://api.example.com",
      convIdentity: "stable",
      ...(pluginConfig ?? {}),
    },
    config: {
      agents: { list: [{ id: "vast" }, { id: "bast" }] },
      bindings: bindings ?? [
        {
          agentId: "vast",
          match: { channel: "discord", accountId: "vast" },
        },
        {
          agentId: "bast",
          match: { channel: "discord", accountId: "default" },
        },
      ],
      channels: {
        discord: {
          accounts: {
            vast: { token: "vast-discord-token" },
            default: { token: "default-discord-token" },
          },
        },
      },
    },
    registerTool: vi.fn(),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  };
  mod.default.register(api);
  return { handlers, log };
}

function prompt(
  replyTargetId = TARGET_MESSAGE_ID,
  currentMessageId = CURRENT_MESSAGE_ID,
) {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      chat_id: `channel:${CHANNEL_ID}`,
      message_id: currentMessageId,
      reply_to_id: replyTargetId,
      sender: { id: CURRENT_SENDER_ID, name: "Send Nudes" },
      group_channel: "gear",
      was_mentioned: true,
      history_count: 1,
    }, null, 2),
    "```",
    "",
    "Chat history since last reply (untrusted, for context):",
    "```json",
    JSON.stringify([{
      sender: "BigTex (cory099924)",
      message_id: "1532425725548953670",
      body: "@dadscientist now show him the REAL stash",
    }], null, 2),
    "```",
    "",
    "System: [2026-07-30 13:00:00 EDT] Discord reaction added: eyes",
    "System: [2026-07-30 13:00:01 EDT] Discord reaction added: brain",
    "System: [2026-07-30 13:00:02 EDT] Discord reaction added: hourglass",
    CURRENT_BODY,
  ].join("\n");
}

function messageHookEvent() {
  return {
    from: `discord:${CURRENT_SENDER_ID}`,
    // Production BodyForCommands still contains the Discord invocation while
    // before_agent_reply.cleanedBody has the bot mention removed.
    content: `<@${VAST_ID}> ${CURRENT_BODY}`,
    timestamp: CURRENT_TIMESTAMP,
    messageId: CURRENT_MESSAGE_ID,
    senderId: CURRENT_SENDER_ID,
    replyToId: TARGET_MESSAGE_ID,
    metadata: {
      provider: "discord",
      originatingChannel: "discord",
      originatingTo: `channel:${CHANNEL_ID}`,
      messageId: CURRENT_MESSAGE_ID,
      senderId: CURRENT_SENDER_ID,
      senderName: "Send Nudes",
      guildId: "1524917037191925871",
      channelName: "gear",
    },
  };
}

function messageHookContext(accountId = "vast") {
  return {
    channelId: "discord",
    accountId,
    conversationId: `channel:${CHANNEL_ID}`,
    messageId: CURRENT_MESSAGE_ID,
    senderId: CURRENT_SENDER_ID,
    replyToId: TARGET_MESSAGE_ID,
  };
}

function agentContext({
  sessionId = SESSION_ID,
  sessionKey = SESSION_KEY,
  runId = RUN_ID,
} = {}) {
  return {
    sessionId,
    sessionKey,
    runId,
    senderId: CURRENT_SENDER_ID,
    channelId: CHANNEL_ID,
    messageProvider: "discord",
    model: "openai/gpt-5.6-sol",
    trigger: "user",
    channelContext: {
      sender: { id: CURRENT_SENDER_ID, name: "Send Nudes" },
    },
  };
}

async function finishRun({
  handlers,
  ctx,
  answer,
  messages = null,
  success = true,
}) {
  await handlers.get("agent_end")({
    runId: ctx.runId,
    success,
    messages: messages ?? [{
      role: "assistant",
      content: [{ type: "text", text: answer }],
    }],
  }, ctx);
  if (!success) return;
  await handlers.get("llm_output")({
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    provider: "openai",
    model: "gpt-5.6-sol",
    assistantTexts: [answer],
    lastAssistant: {
      role: "assistant",
      content: [{ type: "text", text: answer }],
    },
  }, ctx);
}

function stageNativeInbound({
  handlers,
  home,
  event = messageHookEvent(),
  messageContext = messageHookContext(),
  dispatchSessionKey = SESSION_KEY,
  sessionId = SESSION_ID,
  rowContent = CURRENT_BODY,
  dispatchBody = rowContent,
  writeRow = true,
}) {
  handlers.get("message_received")(event, messageContext);
  handlers.get("before_dispatch")({
    content: event.content,
    body: dispatchBody,
    channel: "discord",
    sessionKey: dispatchSessionKey,
    senderId: event.senderId,
    timestamp: event.timestamp,
  }, {
    channelId: "discord",
    accountId: messageContext.accountId,
    conversationId: messageContext.conversationId,
    sessionKey: dispatchSessionKey,
    senderId: event.senderId,
  });
  if (!writeRow) return;
  const agentId = dispatchSessionKey.split(":")[1];
  const sessionDir = join(home, ".openclaw", "agents", agentId, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  appendFileSync(join(sessionDir, `${sessionId}.jsonl`), `${JSON.stringify({
    type: "message",
    message: {
      role: "user",
      timestamp: event.timestamp,
      content: rowContent,
    },
  })}\n`);
}

describe("current Discord sender and reply target", () => {
  it("does not POST a group completion without its exact pending handoff", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers, log } = await registerPlugin(home);
    const guildSessionKey = "agent:vast:discord:guild:1524917037191925871";
    const ctx = agentContext({
      sessionKey: guildSessionKey,
      runId: "run-without-pending-handoff",
    });

    await finishRun({
      handlers,
      ctx,
      answer: "must not be posted",
    });

    expect(calls.some((call) => isIngestHref(call.href)))
      .toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("exact pending handoff unavailable"),
    );
  });

  it("keeps concurrent same-session runs exact through prepare and agent_end", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    const guildId = "1524917037191925871";
    const guildSessionKey = `agent:vast:discord:guild:${guildId}`;
    const sharedBody = "same concurrent body";
    const turns = [
      {
        runId: "run-concurrent-a",
        messageId: "1533000000000000301",
        senderId: "387316537012518913",
        senderName: "optics",
        channelId: "1524946242499514418",
        answer: "answer alpha",
      },
      {
        runId: "run-concurrent-b",
        messageId: "1533000000000000302",
        senderId: "824811108727652373",
        senderName: "BigTex",
        channelId: "1524946242499514419",
        answer: "answer bravo",
      },
    ];

    const contexts = turns.map((turn) => ({
      sessionId: SESSION_ID,
      sessionKey: guildSessionKey,
      runId: turn.runId,
      senderId: turn.senderId,
      channelId: turn.channelId,
      messageProvider: "discord",
      model: "openai/gpt-5.6-sol",
      trigger: "user",
      channelContext: {
        sender: { id: turn.senderId, name: turn.senderName },
      },
    }));
    const promptFor = (turn) => [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({
        chat_id: `channel:${turn.channelId}`,
        message_id: turn.messageId,
        sender: { id: turn.senderId, name: turn.senderName },
        group_channel: `channel-${turn.channelId.at(-1)}`,
        was_mentioned: true,
      }, null, 2),
      "```",
      "",
      sharedBody,
    ].join("\n");

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      const ctx = contexts[index];
      const nativeEvent = {
        content: `<@${VAST_ID}> ${sharedBody}`,
          timestamp: snowflakeTimestamp(turn.messageId),
        messageId: turn.messageId,
        senderId: turn.senderId,
        sessionKey: guildSessionKey,
        metadata: {
          provider: "discord",
          originatingChannel: "discord",
          originatingTo: `channel:${turn.channelId}`,
          messageId: turn.messageId,
          senderId: turn.senderId,
          senderName: turn.senderName,
          guildId,
        },
      };
      const nativeContext = {
        channelId: "discord",
        accountId: "vast",
        conversationId: `channel:${turn.channelId}`,
        sessionKey: guildSessionKey,
        messageId: turn.messageId,
        senderId: turn.senderId,
      };
      stageNativeInbound({
        handlers,
        home,
        event: nativeEvent,
        messageContext: nativeContext,
        dispatchSessionKey: guildSessionKey,
        sessionId: SESSION_ID,
        rowContent: sharedBody,
      });
      await handlers.get("before_agent_reply")(
        { cleanedBody: sharedBody },
        ctx,
      );
      await handlers.get("before_prompt_build")(
        { prompt: promptFor(turn), messages: [] },
        ctx,
      );
    }

    for (const index of [1, 0]) {
      const turn = turns[index];
      await finishRun({
        handlers,
        ctx: contexts[index],
        answer: turn.answer,
      });
    }

    const vcCalls = calls.filter((call) =>
      isPrepareHref(call.href)
      || isIngestHref(call.href)
    );
    const prepares = vcCalls
      .filter((call) => isPrepareHref(call.href))
      .map((call) => JSON.parse(call.options.body));
    const ingests = vcCalls
      .filter((call) => isIngestHref(call.href))
      .map((call) => JSON.parse(call.options.body));
    expect(prepares).toHaveLength(2);
    expect(ingests).toHaveLength(2);
    const preparesBySource = new Map(
      prepares.map((body) => [body.source_message_id, body]),
    );
    const ingestsBySource = new Map(
      ingests.map((body) => [body.source_message_id, body]),
    );
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      const expectedText = sharedBody;
      const prepared = preparesBySource.get(turn.messageId);
      const ingested = ingestsBySource.get(turn.messageId);
      expect(prepared).toMatchObject({
        sender_name: turn.senderName,
        sender_actor_id: `actor:discord:${turn.senderId}`,
        source_message_id: turn.messageId,
        source_attestation: {
          message_id: turn.messageId,
          author_id: turn.senderId,
          channel_id: turn.channelId,
          guild_id: guildId,
        },
      });
      expect(textOf(prepared.messages.at(-1).content)).toBe(expectedText);
      expect(ingested).toMatchObject({
        assistant_message: turn.answer,
        user_message: expectedText,
        sender_name: turn.senderName,
        sender_actor_id: `actor:discord:${turn.senderId}`,
        source_message_id: turn.messageId,
        source_attestation: {
          message_id: turn.messageId,
          author_id: turn.senderId,
          channel_id: turn.channelId,
          guild_id: guildId,
        },
      });
    }
  });

  it("rejects a shared-prompt body that conflicts with the exact dispatch body", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers, log } = await registerPlugin(home);
    stageNativeInbound({ handlers, home, dispatchBody: CURRENT_BODY });
    const ctx = agentContext();
    const wrongBody = "another member's historical request";
    await handlers.get("before_agent_reply")(
      { cleanedBody: wrongBody },
      ctx,
    );
    const conflictingPrompt = prompt().replace(
      new RegExp(`${CURRENT_BODY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      wrongBody,
    );

    const result = await handlers.get("before_prompt_build")(
      { prompt: conflictingPrompt, messages: [] },
      ctx,
    );

    expect(result?.prependContext).toContain("conflicting current-turn");
    expect(result?.prependContext).toContain("do not answer");
    expect(calls.some((call) => isPrepareHref(call.href)))
      .toBe(false);
    expect(calls.some((call) => isIngestHref(call.href)))
      .toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("conflicted with the current prompt projection"),
    );
  });

  it("accepts OpenClaw collapsing harmless horizontal whitespace", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers, log } = await registerPlugin(home);
    const dispatched = (
      "do you remember we discussed a personal follow up question?  "
      + "Give me a new example."
    );
    const promptProjection = (
      "do you remember we discussed a personal follow up question? "
      + "Give me a new example."
    );
    stageNativeInbound({
      handlers,
      home,
      rowContent: dispatched,
      dispatchBody: dispatched,
    });
    await handlers.get("before_agent_reply")(
      { cleanedBody: promptProjection },
      agentContext(),
    );
    const projectedPrompt = prompt().replace(CURRENT_BODY, promptProjection);

    const result = await handlers.get("before_prompt_build")(
      { prompt: projectedPrompt, messages: [] },
      agentContext(),
    );

    expect(result?.prependContext ?? "").not.toContain(
      "conflicting current-turn",
    );
    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    expect(prepareCall).toBeTruthy();
    const prepared = JSON.parse(prepareCall.options.body);
    expect(textOf(prepared.messages.at(-1).content)).toBe(dispatched);
    expect(log.warn.mock.calls.map(([message]) => message).join("\n"))
      .not.toContain("conflicted with the current prompt projection");
  });

  it("waits for run-bound llm_output instead of adopting a shared tail", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    stageNativeInbound({ handlers, home });
    const ctx = agentContext();
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      ctx,
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      ctx,
    );

    await handlers.get("agent_end")({
      runId: RUN_ID,
      success: true,
      messages: [
        { role: "user", content: CURRENT_BODY },
        { role: "assistant", content: [{ type: "text", text: "answer A" }] },
        { role: "user", content: "user B" },
        { role: "assistant", content: [{ type: "text", text: "answer B" }] },
      ],
    }, ctx);
    expect(calls.some((call) => isIngestHref(call.href)))
      .toBe(false);

    await handlers.get("llm_output")({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      provider: "openai",
      model: "gpt-5.6-sol",
      assistantTexts: ["answer A"],
      lastAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "answer A" }],
      },
    }, ctx);
    const ingest = JSON.parse(
      calls.find((call) => isIngestHref(call.href)).options.body,
    );
    expect(ingest.assistant_message).toBe("answer A");
    expect(ingest.assistant_message).not.toBe("answer B");
  });

  it("never persists a failed run even when its tail contains assistant text", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    stageNativeInbound({ handlers, home });
    const ctx = agentContext();
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      ctx,
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      ctx,
    );

    await finishRun({
      handlers,
      ctx,
      answer: "partial answer must not persist",
      success: false,
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "partial answer must not persist" }],
      }],
    });

    expect(calls.some((call) => isIngestHref(call.href)))
      .toBe(false);
  });

  it("keeps Discord group DMs on the legacy non-attested lane", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    const groupDmSessionKey = `agent:vast:discord:group:${CHANNEL_ID}`;
    const event = messageHookEvent();
    delete event.metadata.guildId;
    const ctx = agentContext({ sessionKey: groupDmSessionKey });
    stageNativeInbound({
      handlers,
      home,
      event,
      dispatchSessionKey: groupDmSessionKey,
    });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      ctx,
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      ctx,
    );
    const prepare = JSON.parse(
      calls.find((call) => isPrepareHref(call.href)).options.body,
    );
    expect(prepare).not.toHaveProperty("source_attestation");

    await finishRun({ handlers, ctx, answer: "group DM answer" });
    const ingest = JSON.parse(
      calls.find((call) => isIngestHref(call.href)).options.body,
    );
    expect(ingest.assistant_message).toBe("group DM answer");
    expect(ingest).not.toHaveProperty("source_attestation");
  });

  it("durably retries a timed-out exact completion after plugin restart", async () => {
    const home = makeHome();
    const guildId = "1524917037191925871";
    const guildSessionKey = `agent:vast:discord:guild:${guildId}`;
    const runId = "run-durable-completion";
    const messageId = "1533000000000000399";
    const senderId = "387316537012518913";
    const channelId = "1524946242499514418";
    const body = "retain my exact completion through a timeout";
    const answer = "durable answer";
    let ingestAttempts = 0;
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.includes("/api/v1/context/capabilities")) {
        return new Response(JSON.stringify({
          exact_source_admission_version: 2,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const request = JSON.parse(options.body ?? "{}");
      if (isIngestHref(href)) {
        ingestAttempts += 1;
        if (ingestAttempts === 1) {
          throw new Error("simulated acknowledgement timeout");
        }
        return new Response(JSON.stringify({
          conversation_id: `agent:vast:discord:guild:${guildId}`,
          status: "idempotent",
          canonical_persisted: true,
          source_message_id: messageId,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        conversation_id: "conv",
        body: { messages: request.messages ?? [] },
        metadata: {
          exact_source_admission_version: 2,
          exact_source_admission: exactAdmission(),
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const first = await registerPlugin(home);
    const ctx = {
      sessionId: SESSION_ID,
      sessionKey: guildSessionKey,
      runId,
      senderId,
      channelId,
      messageProvider: "discord",
      model: "openai/gpt-5.6-sol",
      trigger: "user",
      channelContext: { sender: { id: senderId, name: "optics" } },
    };
    const nativeEvent = {
      content: `<@${VAST_ID}> ${body}`,
      timestamp: snowflakeTimestamp(messageId),
      messageId,
      senderId,
      sessionKey: guildSessionKey,
      metadata: {
        provider: "discord",
        originatingChannel: "discord",
        originatingTo: `channel:${channelId}`,
        messageId,
        senderId,
        senderName: "optics",
        guildId,
      },
    };
    stageNativeInbound({
      handlers: first.handlers,
      home,
      event: nativeEvent,
      messageContext: {
        channelId: "discord",
        accountId: "vast",
        conversationId: `channel:${channelId}`,
        sessionKey: guildSessionKey,
        messageId,
        senderId,
      },
      dispatchSessionKey: guildSessionKey,
      sessionId: SESSION_ID,
      rowContent: body,
    });
    await first.handlers.get("before_agent_reply")({ cleanedBody: body }, ctx);
    const promptText = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({
        chat_id: `channel:${channelId}`,
        message_id: messageId,
        sender: { id: senderId, name: "optics" },
        group_channel: "vasttest",
        was_mentioned: true,
      }, null, 2),
      "```",
      "",
      body,
    ].join("\n");
    await first.handlers.get("before_prompt_build")(
      { prompt: promptText, messages: [] },
      ctx,
    );
    await finishRun({
      handlers: first.handlers,
      ctx,
      answer,
    });

    expect(ingestAttempts).toBe(1);
    const outboxRoot = join(
      home, ".openclaw", "state", "virtual-context", "completion-outbox",
    );
    const deploymentDirs = readdirSync(outboxRoot);
    expect(deploymentDirs).toHaveLength(1);
    const outboxDir = join(outboxRoot, deploymentDirs[0]);
    const queuedFiles = readdirSync(outboxDir).filter(
      (name) => name.endsWith(".json"),
    );
    expect(queuedFiles).toHaveLength(1);
    const queuedPath = join(outboxDir, queuedFiles[0]);
    const queuedRecord = JSON.parse(readFileSync(queuedPath, "utf8"));
    expect(queuedRecord.version).toBe(2);
    expect(queuedRecord.payload.exact_source_admission).toEqual(
      exactAdmission(),
    );

    // A key/endpoint rotation is a different deployment scope. It must not
    // replay a completion to the wrong credentials or backend, and it must not
    // delete the original deployment's durable record.
    await registerPlugin(home, {
      pluginConfig: {
        vcKey: "rotated-key",
        baseUrl: "https://api.example.com",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ingestAttempts).toBe(1);
    expect(readdirSync(outboxDir).filter((name) => name.endsWith(".json")))
      .toHaveLength(1);

    await registerPlugin(home);
    const deadline = Date.now() + 1000;
    while (
      readdirSync(outboxDir).some((name) => name.endsWith(".json"))
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(ingestAttempts).toBe(2);
    expect(readdirSync(outboxDir).filter((name) => name.endsWith(".json")))
      .toHaveLength(0);

    // An unfenced v1 record is preserved but never retried after the protocol
    // upgrade. Recreate the historical on-disk shape with its valid original
    // fingerprint and prove startup moves it to dead-letter before fetch.
    writeFileSync(queuedPath, `${JSON.stringify({
      ...queuedRecord,
      version: 1,
    })}\n`);
    await registerPlugin(home);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ingestAttempts).toBe(2);
    expect(readdirSync(outboxDir).filter((name) => name.endsWith(".json")))
      .toHaveLength(0);
    const deadLetterDir = join(
      home, ".openclaw", "state", "virtual-context",
      "completion-dead-letter", deploymentDirs[0],
    );
    const deadLetters = readdirSync(deadLetterDir).filter(
      (name) => name.endsWith(".json"),
    );
    expect(deadLetters).toHaveLength(1);
    const deadLetter = JSON.parse(
      readFileSync(join(deadLetterDir, deadLetters[0]), "utf8"),
    );
    expect(deadLetter.rejection.status)
      .toBe("protocol_generation_fence_missing");
  });

  it("refuses an exact model turn before prepare when cloud capability is absent", async () => {
    const home = makeHome();
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { handlers, log } = await registerPlugin(home);
    const guildSessionKey =
      "agent:vast:discord:guild:1524917037191925871";
    const ctx = agentContext({ sessionKey: guildSessionKey });
    stageNativeInbound({
      handlers,
      home,
      dispatchSessionKey: guildSessionKey,
    });

    const result = await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      ctx,
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain("temporarily unavailable");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/context/capabilities");
    expect(calls.some((url) => isPrepareHref(url))).toBe(false);
    expect(calls.some((url) => isIngestHref(url))).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("exact source preflight failed"),
    );
  });

  it("keeps an exact prepare failure sticky across duplicate prompt passes", async () => {
    const home = makeHome();
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("/api/v1/context/capabilities")) {
        return new Response(JSON.stringify({
          exact_source_admission_version: 2,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (isPrepareHref(href)) {
        return new Response(JSON.stringify({
          error: { type: "mixed_worker", retryable: true },
        }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const { handlers } = await registerPlugin(home);
    const ctx = agentContext({
      sessionKey: "agent:vast:discord:guild:1524917037191925871",
      runId: "run-sticky-exact-refusal",
    });
    const inbound = messageHookEvent();
    inbound.replyToId = "";
    delete inbound.metadata.replyToId;
    const inboundContext = messageHookContext();
    inboundContext.replyToId = "";
    stageNativeInbound({
      handlers,
      home,
      event: inbound,
      messageContext: inboundContext,
      dispatchSessionKey: ctx.sessionKey,
    });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      ctx,
    );
    const hookEvent = {
      prompt: prompt(""),
      messages: [],
    };
    const first = await handlers.get("before_prompt_build")(hookEvent, ctx);
    const second = await handlers.get("before_prompt_build")(hookEvent, ctx);

    for (const result of [first, second]) {
      expect(result?.prependContext).toContain("temporarily unavailable");
      expect(result?.prependContext).toContain("do not answer");
    }
    await finishRun({ handlers, ctx, answer: "must not be persisted" });
    expect(calls.filter((href) => isPrepareHref(href))).toHaveLength(1);
    expect(calls.some((href) => isIngestHref(href))).toBe(false);
    const outboxRoot = join(
      home, ".openclaw", "state", "virtual-context", "completion-outbox",
    );
    expect(() => readdirSync(outboxRoot)).toThrow();
  });

  it("applies provider exclusion before exact capability preflight", async () => {
    const home = makeHome();
    const sessionDir = join(home, ".openclaw", "agents", "vast", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const guildSessionKey =
      "agent:vast:discord:guild:1524917037191925871";
    writeFileSync(
      join(sessionDir, "sessions.json"),
      JSON.stringify({
        [guildSessionKey]: {
          modelProvider: "excluded-provider",
          model: "excluded-model",
        },
      }),
    );
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      throw new Error("excluded provider must not touch Virtual Context");
    });
    const { handlers } = await registerPlugin(home, {
      pluginConfig: { providers: ["openai/gpt-5.6-sol"] },
    });
    const ctx = agentContext({ sessionKey: guildSessionKey });
    stageNativeInbound({
      handlers,
      home,
      dispatchSessionKey: guildSessionKey,
    });

    const replyGate = await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      ctx,
    );
    const promptGate = await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      ctx,
    );

    expect(replyGate).toBeUndefined();
    expect(promptGate).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("preserves per-conversation FIFO without starving another conversation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    const home = makeHome();
    const guildA = "1524917037191925871";
    const guildB = "1524917037191925872";
    const sources = {
      // The first enqueue deliberately has the larger snowflake. With equal
      // millisecond timestamps, source-id sorting would let a2 overtake it.
      a1: "1533000000000000499",
      a2: "1533000000000000401",
      b1: "1533000000000000403",
    };
    const attempted = [];
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.includes("/context/capabilities")) {
        return new Response(JSON.stringify({
          exact_source_admission_version: 2,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const request = JSON.parse(options.body ?? "{}");
      if (isPrepareHref(href)) {
        return new Response(JSON.stringify({
          conversation_id: "conv",
          body: { messages: request.messages ?? [] },
          metadata: {
            exact_source_admission_version: 2,
            exact_source_admission: exactAdmission(),
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (isIngestHref(href)) {
        const source = request.source_attestation.message_id;
        attempted.push(source);
        if (source === sources.a1) {
          throw new Error("conversation A head is retrying");
        }
        return new Response(JSON.stringify({
          conversation_id: "conv",
          status: "accepted",
          canonical_persisted: true,
          source_message_id: source,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const { handlers } = await registerPlugin(home);

    const runTurn = async ({ source, guild, sessionId, runId, answer }) => {
      const channelId = String(BigInt(guild) + 1000n);
      const senderId = "387316537012518913";
      const body = `body ${source}`;
      const sessionKey = `agent:vast:discord:guild:${guild}`;
      const ctx = {
        sessionId,
        sessionKey,
        runId,
        senderId,
        channelId,
        messageProvider: "discord",
        model: "openai/gpt-5.6-sol",
        trigger: "user",
        channelContext: { sender: { id: senderId, name: "optics" } },
      };
      const event = {
        content: `<@${VAST_ID}> ${body}`,
        timestamp: snowflakeTimestamp(source),
        messageId: source,
        senderId,
        metadata: {
          provider: "discord",
          originatingChannel: "discord",
          originatingTo: `channel:${channelId}`,
          messageId: source,
          senderId,
          senderName: "optics",
          guildId: guild,
        },
      };
      stageNativeInbound({
        handlers,
        home,
        event,
        messageContext: {
          channelId: "discord",
          accountId: "vast",
          conversationId: `channel:${channelId}`,
          messageId: source,
          senderId,
        },
        dispatchSessionKey: sessionKey,
        sessionId,
        rowContent: body,
      });
      await handlers.get("before_agent_reply")({ cleanedBody: body }, ctx);
      await handlers.get("before_prompt_build")({
        prompt: [
          "Conversation info (untrusted metadata):",
          "```json",
          JSON.stringify({
            chat_id: `channel:${channelId}`,
            message_id: source,
            sender: { id: senderId, name: "optics" },
            group_channel: "test",
            was_mentioned: true,
          }),
          "```",
          "",
          body,
        ].join("\n"),
        messages: [],
      }, ctx);
      await finishRun({ handlers, ctx, answer });
    };

    await runTurn({
      source: sources.a1,
      guild: guildA,
      sessionId: SESSION_ID,
      runId: "fifo-a1",
      answer: "answer a1",
    });
    // A wall-clock correction must not let the later enqueue become the head.
    vi.setSystemTime(new Date("2026-08-02T09:59:00.000Z"));
    await runTurn({
      source: sources.a2,
      guild: guildA,
      sessionId: SESSION_ID,
      runId: "fifo-a2",
      answer: "answer a2",
    });
    await runTurn({
      source: sources.b1,
      guild: guildB,
      sessionId: OTHER_SESSION_ID,
      runId: "fifo-b1",
      answer: "answer b1",
    });

    expect(attempted).toEqual([sources.a1, sources.b1]);
  });

  it("joins a production-shaped inbound hook by exact run despite mention cleanup", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    const received = messageHookEvent();
    // The shipped hook contract can omit these convenience duplicates. The
    // immutable ids still exist in message_received.metadata, while dispatch
    // owns the resolved sender/channel/session tuple.
    delete received.messageId;
    delete received.senderId;
    delete received.sessionKey;
    delete received.replyToId;
    delete received.metadata.replyToId;
    handlers.get("message_received")(received, {
      channelId: "discord",
      accountId: "vast",
      conversationId: `channel:${CHANNEL_ID}`,
    });
    handlers.get("before_dispatch")({
      content: received.content,
      body: CURRENT_BODY,
      channel: "discord",
      sessionKey: SESSION_KEY,
      senderId: CURRENT_SENDER_ID,
      timestamp: CURRENT_TIMESTAMP,
    }, {
      channelId: "discord",
      accountId: "vast",
      conversationId: `channel:${CHANNEL_ID}`,
      sessionKey: SESSION_KEY,
      senderId: CURRENT_SENDER_ID,
    });
    const promptContext = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      runId: RUN_ID,
      model: "openai/gpt-5.6-sol",
      trigger: "user",
    };
    const event = { prompt: prompt(), messages: [] };
    const result = await handlers.get("before_prompt_build")(event, promptContext);

    expect(result.prependContext).toContain("<current-speaker");
    expect(result.prependContext).toContain(`actor:discord:${CURRENT_SENDER_ID}`);
    expect(result.prependContext).toContain("Send Nudes");
    expect(result.prependContext).toContain("<current-reply-target");
    expect(result.prependContext).toContain(TARGET_MESSAGE_ID);
    expect(result.prependContext).toContain(TARGET_BODY);
    expect(result.prependContext).toContain("Vast");

    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    const prepare = JSON.parse(prepareCall.options.body);
    expect(textOf(prepare.messages.at(-1).content)).toBe(CURRENT_BODY);
    expect(textOf(prepare.messages.at(-1).content)).not.toContain("Discord reaction added");
    expect(prepare).toMatchObject({
      sender_name: "Send Nudes",
      sender_actor_id: `actor:discord:${CURRENT_SENDER_ID}`,
      source_message_id: CURRENT_MESSAGE_ID,
      reply_target_message_id: TARGET_MESSAGE_ID,
      reply_subject_actor_id: `actor:discord:${VAST_ID}`,
      reply_subject_label: "Vast",
      reply_target_body: TARGET_BODY,
      source_attestation: {
        version: 1,
        agent_scope_id: "vast",
        platform: "discord",
        account_id: "vast",
        message_id: CURRENT_MESSAGE_ID,
        channel_id: CHANNEL_ID,
        guild_id: "1524917037191925871",
        author_id: CURRENT_SENDER_ID,
        projection_version: "openclaw-current-user-v1",
        reply_target_message_id: TARGET_MESSAGE_ID,
      },
    });
    expect(prepare.source_attestation.transport_body_sha256).toHaveLength(64);
    expect(prepare.source_attestation.canonical_body_sha256).toHaveLength(64);
    expect(prepare.source_attestation.transport_body_sha256).toBe(
      "6cf337dde932b7b7deee1c4d88b42efedc127269740698deeff594139e921469",
    );
    expect(prepare.source_attestation.canonical_body_sha256).toBe(
      "2621e94b075651cf642c45724446ccc7553e0867c38b29a61ce2db74f8ae96cb",
    );
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(1);
  });

  it("moves the exact nontrailing native row to the model tail and completion", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    stageNativeInbound({ handlers, home });
    const ctx = agentContext();
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      ctx,
    );
    const historicalAfterCurrent = {
      role: "user",
      content: [{ type: "text", text: "another user's later history row" }],
      senderId: "824811108727652373",
      senderName: "BigTex",
      timestamp: CURRENT_TIMESTAMP + 1,
    };
    const currentFlushedRow = {
      role: "user",
      content: [{ type: "text", text: CURRENT_BODY }],
      senderId: CURRENT_SENDER_ID,
      senderName: "Send Nudes",
      timestamp: CURRENT_TIMESTAMP,
    };
    await handlers.get("before_prompt_build")({
      prompt: prompt(),
      messages: [currentFlushedRow, historicalAfterCurrent],
    }, ctx);

    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    const prepare = JSON.parse(prepareCall.options.body);
    expect(textOf(prepare.messages.at(-1).content)).toBe(CURRENT_BODY);
    expect(prepare.source_attestation.message_id).toBe(CURRENT_MESSAGE_ID);

    await finishRun({
      handlers,
      ctx,
      answer: "answer for exact current row",
    });
    const ingestCall = calls.find((call) => isIngestHref(call.href));
    const ingest = JSON.parse(ingestCall.options.body);
    expect(ingest.user_message).toBe(CURRENT_BODY);
    expect(ingest.user_message).not.toBe("another user's later history row");
    expect(ingest.source_attestation.message_id).toBe(CURRENT_MESSAGE_ID);
  });

  it("does not attest prior history when the current Discord body is empty", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    stageNativeInbound({
      handlers,
      home,
      dispatchBody: "",
      writeRow: false,
    });
    const ctx = agentContext();
    await handlers.get("before_agent_reply")({ cleanedBody: "" }, ctx);
    const metadataOnlyPrompt = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({
        chat_id: `channel:${CHANNEL_ID}`,
        message_id: CURRENT_MESSAGE_ID,
        sender: { id: CURRENT_SENDER_ID, name: "Send Nudes" },
        group_channel: "gear",
        was_mentioned: true,
      }),
      "```",
    ].join("\n");
    await handlers.get("before_prompt_build")({
      prompt: metadataOnlyPrompt,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "prior user's historical body" }],
        senderId: "824811108727652373",
        timestamp: CURRENT_TIMESTAMP - 1,
      }],
    }, ctx);
    expect(calls.some((call) => isPrepareHref(call.href)))
      .toBe(false);

    await finishRun({
      handlers,
      ctx,
      answer: "must not be paired",
    });
    expect(calls.some((call) => isIngestHref(call.href)))
      .toBe(false);
  });

  it("never gives repeated current text another member's historical label", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    const repeatedBody = "yes";
    const received = messageHookEvent();
    received.content = `<@${VAST_ID}> ${repeatedBody}`;
    stageNativeInbound({
      handlers,
      home,
      event: received,
      rowContent: repeatedBody,
      writeRow: false,
    });
    const sessionDir = join(home, ".openclaw", "agents", "vast", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const historicalRows = [
      {
        type: "message",
        message: {
          role: "user",
          senderName: "BigTex",
          content: repeatedBody,
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          senderName: "optics",
          content: "a different historical phrase",
        },
      },
    ];
    writeFileSync(
      join(sessionDir, `${SESSION_ID}.jsonl`),
      historicalRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const ctx = agentContext();
    await handlers.get("before_agent_reply")(
      { cleanedBody: repeatedBody },
      ctx,
    );
    const promptText = prompt().replaceAll(CURRENT_BODY, repeatedBody);
    await handlers.get("before_prompt_build")({
      prompt: promptText,
      messages: [{
        role: "user",
        content: [{ type: "text", text: repeatedBody }],
        senderId: "824811108727652373",
        senderName: "BigTex",
        timestamp: CURRENT_TIMESTAMP - 1,
      }],
    }, ctx);
    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    const prepare = JSON.parse(prepareCall.options.body);
    const currentText = textOf(prepare.messages.at(-1).content);
    expect(currentText).not.toBe(`BigTex: ${repeatedBody}`);
    expect(currentText).toBe(`Send Nudes: ${repeatedBody}`);
    expect(prepare.sender_actor_id).toBe(
      `actor:discord:${CURRENT_SENDER_ID}`,
    );
  });

  it("does not mint source identity without a native timestamp", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers, log } = await registerPlugin(home);
    const forgedLegacyShape = {
      from: `discord:${CURRENT_SENDER_ID}`,
      content: CURRENT_BODY,
      messageId: CURRENT_MESSAGE_ID,
      senderId: CURRENT_SENDER_ID,
      guildId: "1524917037191925871",
      sessionKey: SESSION_KEY,
    };

    handlers.get("message_received")(forgedLegacyShape, {
      channelId: "discord",
      accountId: "vast",
      conversationId: `channel:${CHANNEL_ID}`,
      messageId: CURRENT_MESSAGE_ID,
      senderId: CURRENT_SENDER_ID,
      sessionKey: SESSION_KEY,
    });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext(),
    );

    expect(calls.some((call) => isPrepareHref(call.href)))
      .toBe(false);
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("missing=timestamp"),
    );
  });

  it("drops a duplicate run when native reply or timestamp evidence changes", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    stageNativeInbound({ handlers, home });
    const conflicting = messageHookEvent();
    conflicting.replyToId = "1532423627536863999";
    conflicting.timestamp += 1;
    handlers.get("message_received")(conflicting, messageHookContext());

    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext(),
    );

    expect(calls.some((call) => isPrepareHref(call.href)))
      .toBe(false);
  });

  it("uses the exact run account when an agent has multiple Discord bindings", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers, log } = await registerPlugin(home, {
      bindings: [
        { agentId: "vast", match: { channel: "discord", accountId: "vast" } },
        { agentId: "vast", match: { channel: "discord", accountId: "other" } },
      ],
    });

    stageNativeInbound({ handlers, home });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext(),
    );

    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    expect(JSON.parse(prepareCall.options.body).source_attestation).toMatchObject({
      account_id: "vast",
      message_id: CURRENT_MESSAGE_ID,
      author_id: CURRENT_SENDER_ID,
    });
    expect(log.warn.mock.calls.map(([message]) => message).join("\n"))
      .not.toContain("binding is missing or ambiguous");
  });

  it("uses the invoked body instead of a host-added local media prefix", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);

    stageNativeInbound({ handlers, home });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    const mediaPrompt = prompt().replace(
      CURRENT_BODY,
      `[media attached: /root/.openclaw/media/inbound/example.jpg]\n${CURRENT_BODY}`,
    );
    const result = await handlers.get("before_prompt_build")(
      { prompt: mediaPrompt, messages: [] },
      agentContext(),
    );

    expect(result.prependContext).toContain("<current-reply-target");
    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    const prepare = JSON.parse(prepareCall.options.body);
    expect(textOf(prepare.messages.at(-1).content)).toBe(CURRENT_BODY);
    expect(textOf(prepare.messages.at(-1).content)).not.toContain("/root/");
  });

  it("does not reuse one message snapshot for a different prompt run", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);

    stageNativeInbound({ handlers, home });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    const first = await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext(),
    );
    const second = await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext({ runId: "different-prompt-run" }),
    );

    expect(first.prependContext).toContain("<current-reply-target");
    expect(second?.prependContext ?? "").not.toContain("<current-reply-target");
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(1);
  });

  it("claims the exact run when two same-speaker events are pending", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    const secondMessageId = "1532432883887767998";
    const secondEvent = messageHookEvent();
    secondEvent.messageId = secondMessageId;
    secondEvent.metadata.messageId = secondMessageId;
    secondEvent.timestamp = snowflakeTimestamp(secondMessageId);

    stageNativeInbound({ handlers, home });
    stageNativeInbound({
      handlers,
      home,
      event: secondEvent,
      messageContext: {
        ...messageHookContext("vast"),
        messageId: secondMessageId,
      },
    });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext(),
    );

    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    const prepare = JSON.parse(prepareCall.options.body);
    expect(prepare.sender_actor_id).toBe(`actor:discord:${CURRENT_SENDER_ID}`);
    expect(prepare.source_attestation).toMatchObject({
      message_id: CURRENT_MESSAGE_ID,
      author_id: CURRENT_SENDER_ID,
    });
  });

  it("binds identical same-speaker messages in reverse invocation order", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    const secondMessageId = "1532432883887767998";
    const secondRunId = "9fc3ab66-2c7f-4c23-b450-ce3dcbe3b49f";
    const secondEvent = messageHookEvent();
    secondEvent.messageId = secondMessageId;
    secondEvent.metadata.messageId = secondMessageId;
    secondEvent.timestamp = snowflakeTimestamp(secondMessageId);
    stageNativeInbound({ handlers, home });
    stageNativeInbound({
      handlers,
      home,
      event: secondEvent,
      messageContext: {
        ...messageHookContext(),
        messageId: secondMessageId,
      },
    });

    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext({ runId: secondRunId }),
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(TARGET_MESSAGE_ID, secondMessageId), messages: [] },
      agentContext({ runId: secondRunId }),
    );
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext(),
    );

    const sourceIds = calls
      .filter((call) => isPrepareHref(call.href))
      .map((call) => JSON.parse(call.options.body).source_attestation?.message_id);
    expect(sourceIds).toEqual([secondMessageId, CURRENT_MESSAGE_ID]);
  });

  it("uses the exact snowflake when same-sender messages share one millisecond", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    const secondEvent = messageHookEvent();
    secondEvent.messageId = "1532432883887767998";
    secondEvent.metadata.messageId = secondEvent.messageId;
    stageNativeInbound({ handlers, home });
    stageNativeInbound({
      handlers,
      home,
      event: secondEvent,
      messageContext: {
        ...messageHookContext(),
        messageId: secondEvent.messageId,
      },
    });

    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext(),
    );

    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    expect(JSON.parse(prepareCall.options.body).source_attestation).toMatchObject({
      message_id: CURRENT_MESSAGE_ID,
      author_id: CURRENT_SENDER_ID,
    });
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(1);
  });

  it("replaces the current JSONL row instead of appending it twice", async () => {
    const home = makeHome();
    const calls = installFetch();
    const sessionDir = join(home, ".openclaw", "agents", "vast", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          senderId: "824811108727652373",
          senderName: "BigTex",
          timestamp: Date.parse("2026-07-30T16:58:00.000Z"),
          content: "earlier context",
        },
      },
      { type: "message", message: { role: "assistant", content: "earlier answer" } },
      {
        type: "message",
        message: {
          role: "user",
          senderId: CURRENT_SENDER_ID,
          senderName: "Send Nudes",
          sourceChannel: "discord",
          timestamp: CURRENT_TIMESTAMP,
          content: CURRENT_BODY,
        },
      },
    ];
    writeFileSync(
      join(sessionDir, `${SESSION_ID}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const { handlers } = await registerPlugin(home);

    stageNativeInbound({ handlers, home, writeRow: false });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext(),
    );

    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    const prepare = JSON.parse(prepareCall.options.body);
    const currentRows = prepare.messages.filter((message) =>
      message.role === "user" && textOf(message.content).includes(CURRENT_BODY)
    );
    expect(currentRows).toHaveLength(1);
    expect(textOf(prepare.messages.at(-1).content)).toBe(
      `Send Nudes: ${CURRENT_BODY}`,
    );
    expect(prepare.source_attestation).toMatchObject({
      message_id: CURRENT_MESSAGE_ID,
      author_id: CURRENT_SENDER_ID,
    });
  });

  it("does not join when the prompt names a different current message", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);

    stageNativeInbound({ handlers, home });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    const result = await handlers.get("before_prompt_build")(
      { prompt: prompt(TARGET_MESSAGE_ID, "1532432883887767999"), messages: [] },
      agentContext(),
    );

    expect(result?.prependContext ?? "").not.toContain("<current-reply-target");
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(0);
  });

  it("does not join when the host wrapper names a different current sender", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);

    stageNativeInbound({ handlers, home });
    const forged = prompt().replace(
      `"id": "${CURRENT_SENDER_ID}"`,
      '"id": "824811108727652373"',
    );
    await handlers.get("before_prompt_build")(
      { prompt: forged, messages: [] },
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        runId: RUN_ID,
        model: "openai/gpt-5.6-sol",
        trigger: "user",
      },
    );

    expect(calls.some((call) => isPrepareHref(call.href)))
      .toBe(false);
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(0);
  });

  it("rejects a prompt-only reply target when Discord proves a different edge", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);
    const event = messageHookEvent();
    delete event.replyToId;
    delete event.metadata.replyToId;
    stageNativeInbound({
      handlers,
      home,
      event,
      messageContext: {
        channelId: "discord",
        accountId: "vast",
        conversationId: `channel:${CHANNEL_ID}`,
      },
      writeRow: false,
    });
    const forgedTarget = "1532423627536863999";
    const result = await handlers.get("before_prompt_build")(
      { prompt: prompt(forgedTarget), messages: [] },
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        runId: RUN_ID,
        model: "openai/gpt-5.6-sol",
        trigger: "user",
      },
    );

    expect(result?.prependContext ?? "").not.toContain("<current-reply-target");
    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    const prepare = JSON.parse(prepareCall.options.body);
    expect(prepare).not.toHaveProperty("reply_target_message_id");
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(1);
  });

  it("fails closed when two bound Discord accounts can donate the same envelope", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home, {
      bindings: [
        { agentId: "vast", match: { channel: "discord", accountId: "vast" } },
        { agentId: "vast", match: { channel: "discord", accountId: "other" } },
      ],
    });

    for (const accountId of ["vast", "other"]) {
      const event = messageHookEvent();
      handlers.get("message_received")(event, messageHookContext(accountId));
      handlers.get("before_dispatch")({
        content: event.content,
        body: CURRENT_BODY,
        channel: "discord",
        sessionKey: SESSION_KEY,
        senderId: CURRENT_SENDER_ID,
        timestamp: CURRENT_TIMESTAMP,
      }, {
        channelId: "discord",
        accountId,
        conversationId: `channel:${CHANNEL_ID}`,
        sessionKey: SESSION_KEY,
        senderId: CURRENT_SENDER_ID,
      });
    }
    await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        runId: RUN_ID,
        model: "openai/gpt-5.6-sol",
        trigger: "user",
      },
    );

    expect(calls.some((call) => isPrepareHref(call.href)))
      .toBe(false);
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(0);
  });

  it("keeps the same Discord message independent across two agent routes", async () => {
    const home = makeHome();
    const calls = installFetch({
      expectedDiscordTokens: [
        "Bot vast-discord-token",
        "Bot default-discord-token",
      ],
    });
    const { handlers } = await registerPlugin(home);

    stageNativeInbound({ handlers, home });
    stageNativeInbound({
      handlers,
      home,
      event: messageHookEvent(),
      messageContext: messageHookContext("default"),
      dispatchSessionKey: OTHER_SESSION_KEY,
      sessionId: OTHER_SESSION_ID,
    });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext({
        sessionId: OTHER_SESSION_ID,
        sessionKey: OTHER_SESSION_KEY,
        runId: OTHER_RUN_ID,
      }),
    );

    const vastResult = await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext(),
    );
    const bastResult = await handlers.get("before_prompt_build")(
      { prompt: prompt(), messages: [] },
      agentContext({
        sessionId: OTHER_SESSION_ID,
        sessionKey: OTHER_SESSION_KEY,
        runId: OTHER_RUN_ID,
      }),
    );

    expect(vastResult.prependContext).toContain("<current-reply-target");
    expect(bastResult.prependContext).toContain("<current-reply-target");
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(2);
  });

  it("ignores conflicting prompt reply prose and verifies the native event", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);

    stageNativeInbound({ handlers, home });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    const event = { prompt: prompt("1532423627536863999"), messages: [] };
    const result = await handlers.get("before_prompt_build")(event, agentContext());

    expect(result?.prependContext ?? "").toContain("<current-speaker");
    expect(result?.prependContext ?? "").toContain("<current-reply-target");
    expect(result?.prependContext ?? "").toContain(TARGET_MESSAGE_ID);
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(1);
    const prepareCall = calls.find((call) => isPrepareHref(call.href));
    const prepare = JSON.parse(prepareCall.options.body);
    expect(prepare.sender_actor_id).toBe(`actor:discord:${CURRENT_SENDER_ID}`);
    expect(prepare.reply_target_message_id).toBe(TARGET_MESSAGE_ID);
    expect(prepare.reply_target_body).toBe(TARGET_BODY);
    expect(prepare.reply_subject_actor_id).toBe(`actor:discord:${VAST_ID}`);
  });

  it("does not quote a target edited after the reply was created", async () => {
    const home = makeHome();
    installFetch({ targetEditedTimestamp: "2026-07-30T17:02:00.000Z" });
    const { handlers } = await registerPlugin(home);

    stageNativeInbound({ handlers, home });
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    const event = { prompt: prompt(), messages: [] };
    const result = await handlers.get("before_prompt_build")(event, agentContext());

    expect(result.prependContext).toContain('status="unavailable"');
    expect(result.prependContext).not.toContain(TARGET_BODY);
    expect(result.prependContext).toContain(
      "Do not bind this message to an unrelated recent message",
    );
  });
});
