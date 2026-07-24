import { afterEach, describe, expect, it, vi } from "vitest";

import plugin, {
  buildGuildObservation,
  createObservationQueue,
  isExplicitVcInvocation,
} from "../index.js";

const GUILD = "1524917037191925871";
const CHANNEL = "1524946242499514418";
const BOT = "1485681229608259666";
const SENDER = "387316537012518913";
const MESSAGE = "1529000000000000001";
const GROUP_KEY = `agent:vast:discord:guild:${GUILD}`;
const WILDCARD = "agent:vast:discord:channel:*";
const CONV = `sk:${GROUP_KEY}`;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function openClawConfig() {
  return {
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
              [GUILD]: {
                channels: { "*": { enabled: true } },
              },
            },
          },
        },
      },
    },
  };
}

function receivedEvent(content = "NuncaBob should read Ancillary Justice.") {
  return {
    content,
    timestamp: 1784808000000,
    metadata: {
      guildId: GUILD,
      channelName: "vasttest",
      messageId: MESSAGE,
      senderId: SENDER,
      senderName: "Optics",
      senderUsername: "optics",
      originatingTo: `channel:${CHANNEL}`,
    },
  };
}

function messageContext() {
  return {
    channelId: "discord",
    accountId: "vast",
    conversationId: CHANNEL,
  };
}

function registerObservationPlugin() {
  const handlers = new Map();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const api = {
    logger,
    pluginConfig: {
      vcKey: "test-key",
      baseUrl: "https://api.example.com",
      convIdentity: "stable",
      conversationGroups: { [GROUP_KEY]: [WILDCARD] },
      observeGuildMessages: true,
      observeBotUserId: BOT,
      observeFallbackDelayMs: 60000,
    },
    config: openClawConfig(),
    registerTool: vi.fn(),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  };
  plugin.register(api);
  return { handlers, logger };
}

describe("guild observation transport boundary", () => {
  it("builds only a certified guild-scoped VC observation", () => {
    const groupIndex = new Map([[WILDCARD, GROUP_KEY]]);
    const observation = buildGuildObservation(
      receivedEvent(),
      messageContext(),
      {
        conversationGroups: { [GROUP_KEY]: [WILDCARD] },
        groupIndex,
        observeBotUserId: BOT,
      },
    );

    expect(observation.convId).toBe(CONV);
    expect(observation.body).toMatchObject({
      platform: "discord",
      guild_id: GUILD,
      channel_id: CHANNEL,
      source_message_id: MESSAGE,
      sender_id: SENDER,
      sender_name: "Optics",
      content: "NuncaBob should read Ancillary Justice.",
    });

    expect(buildGuildObservation(
      { ...receivedEvent(), metadata: { ...receivedEvent().metadata, guildId: undefined } },
      messageContext(),
      {
        conversationGroups: { [GROUP_KEY]: [WILDCARD] },
        groupIndex,
        observeBotUserId: BOT,
      },
    )).toBeNull();
  });

  it("recognizes only transport invocation shapes, not semantic preferences", () => {
    const cfg = { observeBotUserId: BOT };
    expect(isExplicitVcInvocation(`<@${BOT}> answer this`, {}, cfg)).toBe(true);
    expect(isExplicitVcInvocation("@Vast answer this", {}, cfg)).toBe(true);
    expect(isExplicitVcInvocation("Vast: answer this", {}, cfg)).toBe(true);
    expect(isExplicitVcInvocation("/status", {}, cfg)).toBe(true);
    expect(isExplicitVcInvocation("plain reply", { replyToSender: "Vast" }, cfg))
      .toBe(true);
    expect(isExplicitVcInvocation(
      "plain reply",
      { replyToSender: "Devastator" },
      cfg,
    )).toBe(false);
    expect(isExplicitVcInvocation(
      "For future replies, begin with Compass:",
      {},
      cfg,
    )).toBe(false);
  });

  it("posts an ambient message once and skips explicit/reply invocations", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      conversation_id: CONV,
      status: "observed",
      merge_mode: "observation_append",
      canonical_turn_id: "canonical-1",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    globalThis.fetch = fetchSpy;
    const { handlers } = registerObservationPlugin();

    handlers.get("message_received")(receivedEvent(), messageContext());
    handlers.get("before_dispatch")({
      body: receivedEvent().content,
      senderId: SENDER,
      timestamp: receivedEvent().timestamp,
    }, {
      ...messageContext(),
      senderId: SENDER,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, request] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/v1/context/observe");
    expect(String(url)).toContain(`vcconv=${encodeURIComponent(CONV)}`);
    expect(JSON.parse(request.body)).toMatchObject({
      guild_id: GUILD,
      channel_id: CHANNEL,
      source_message_id: MESSAGE,
      sender_id: SENDER,
    });

    handlers.get("message_received")(
      receivedEvent(`<@${BOT}> explicit`),
      messageContext(),
    );
    handlers.get("message_received")(
      receivedEvent("reply-only invocation"),
      messageContext(),
    );
    handlers.get("before_dispatch")({
      body: "reply-only invocation",
      senderId: SENDER,
      timestamp: receivedEvent().timestamp,
    }, {
      ...messageContext(),
      senderId: SENDER,
      replyToSender: "Vast",
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("delivers sequentially, retries once, and refuses overflow", async () => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const send = vi.fn()
      .mockImplementationOnce(() => firstGate)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ ok: true });
    const log = { warn: vi.fn(), error: vi.fn() };
    const queue = createObservationQueue({
      send,
      log,
      maxSize: 1,
      retryDelayMs: 0,
    });

    expect(queue.enqueue({ messageId: "1" })).toBe(true);
    expect(queue.enqueue({ messageId: "2" })).toBe(true);
    expect(queue.enqueue({ messageId: "3" })).toBe(false);
    releaseFirst();
    await queue.waitForIdle();

    expect(send).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
