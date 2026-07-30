import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

function installFetch({
  targetEditedTimestamp = null,
  expectedDiscordTokens = ["Bot vast-discord-token"],
} = {}) {
  const calls = [];
  let discordCallIndex = 0;
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, options });
    if (href.startsWith("https://discord.com/api/")) {
      expect(options.headers.Authorization).toBe(
        expectedDiscordTokens[discordCallIndex],
      );
      discordCallIndex += 1;
      return new Response(JSON.stringify({
        id: CURRENT_MESSAGE_ID,
        channel_id: CHANNEL_ID,
        content: CURRENT_BODY,
        timestamp: "2026-07-30T17:01:00.000Z",
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
          timestamp: "2026-07-30T16:24:00.000Z",
          edited_timestamp: targetEditedTimestamp,
          author: { id: VAST_ID, username: "Vast", global_name: "Vast" },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const request = JSON.parse(options.body ?? "{}");
    const payload = href.includes("/context/ingest")
      ? { conversation_id: "conv", status: "ok" }
      : {
          conversation_id: "conv",
          body: { messages: request.messages ?? [] },
          metadata: {},
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
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
    config: {
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

function messageHookEvent(sessionKey = SESSION_KEY) {
  return {
    from: `discord:${CURRENT_SENDER_ID}`,
    content: CURRENT_BODY,
    messageId: CURRENT_MESSAGE_ID,
    senderId: CURRENT_SENDER_ID,
    replyToId: TARGET_MESSAGE_ID,
    sessionKey,
  };
}

function messageHookContext(
  sessionKey = SESSION_KEY,
  accountId = "vast",
) {
  return {
    channelId: "discord",
    accountId,
    conversationId: `channel:${CHANNEL_ID}`,
    messageId: CURRENT_MESSAGE_ID,
    senderId: CURRENT_SENDER_ID,
    replyToId: TARGET_MESSAGE_ID,
    sessionKey,
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

describe("current Discord sender and reply target", () => {
  it("joins a production-shaped runless inbound hook by message id", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);

    handlers.get("message_received")(messageHookEvent(), messageHookContext());
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    const event = { prompt: prompt(), messages: [] };
    const result = await handlers.get("before_prompt_build")(event, agentContext());

    expect(result.prependContext).toContain("<current-speaker");
    expect(result.prependContext).toContain(`actor:discord:${CURRENT_SENDER_ID}`);
    expect(result.prependContext).toContain("Send Nudes");
    expect(result.prependContext).toContain("<current-reply-target");
    expect(result.prependContext).toContain(TARGET_MESSAGE_ID);
    expect(result.prependContext).toContain(TARGET_BODY);
    expect(result.prependContext).toContain("Vast");

    const prepareCall = calls.find((call) => call.href.includes("/context/prepare"));
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
    });
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(1);
  });

  it("uses the invoked body instead of a host-added local media prefix", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);

    handlers.get("message_received")(messageHookEvent(), messageHookContext());
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
    const prepareCall = calls.find((call) => call.href.includes("/context/prepare"));
    const prepare = JSON.parse(prepareCall.options.body);
    expect(textOf(prepare.messages.at(-1).content)).toBe(CURRENT_BODY);
    expect(textOf(prepare.messages.at(-1).content)).not.toContain("/root/");
  });

  it("does not reuse one message snapshot for a different prompt run", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);

    handlers.get("message_received")(messageHookEvent(), messageHookContext());
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

  it("does not join when the prompt names a different current message", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);

    handlers.get("message_received")(messageHookEvent(), messageHookContext());
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

  it("keeps the same Discord message independent across two agent routes", async () => {
    const home = makeHome();
    const calls = installFetch({
      expectedDiscordTokens: [
        "Bot vast-discord-token",
        "Bot default-discord-token",
      ],
    });
    const { handlers } = await registerPlugin(home);

    handlers.get("message_received")(
      messageHookEvent(),
      messageHookContext(),
    );
    handlers.get("message_received")(
      messageHookEvent(OTHER_SESSION_KEY),
      messageHookContext(OTHER_SESSION_KEY, "default"),
    );
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

  it("fails closed when prompt reply metadata disagrees with the channel event", async () => {
    const home = makeHome();
    const calls = installFetch();
    const { handlers } = await registerPlugin(home);

    handlers.get("message_received")(messageHookEvent(), messageHookContext());
    await handlers.get("before_agent_reply")(
      { cleanedBody: CURRENT_BODY },
      agentContext(),
    );
    const event = { prompt: prompt("1532423627536863999"), messages: [] };
    const result = await handlers.get("before_prompt_build")(event, agentContext());

    expect(result?.prependContext ?? "").toContain("<current-speaker");
    expect(result?.prependContext ?? "").not.toContain("<current-reply-target");
    expect(calls.filter((call) => call.href.startsWith("https://discord.com/api/")))
      .toHaveLength(0);
    const prepareCall = calls.find((call) => call.href.includes("/context/prepare"));
    const prepare = JSON.parse(prepareCall.options.body);
    expect(prepare.sender_actor_id).toBe(`actor:discord:${CURRENT_SENDER_ID}`);
    expect(prepare).not.toHaveProperty("reply_target_message_id");
    expect(prepare).not.toHaveProperty("reply_target_body");
    expect(prepare).not.toHaveProperty("reply_subject_actor_id");
  });

  it("does not quote a target edited after the reply was created", async () => {
    const home = makeHome();
    installFetch({ targetEditedTimestamp: "2026-07-30T17:02:00.000Z" });
    const { handlers } = await registerPlugin(home);

    handlers.get("message_received")(messageHookEvent(), messageHookContext());
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
