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
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
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
            token: "test-discord-token",
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
  const services = new Map();
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
      observeDiscordAccountId: "vast",
      observeFallbackDelayMs: 60000,
    },
    config: openClawConfig(),
    registerTool: vi.fn(),
    registerService: vi.fn((service) => services.set(service.id, service)),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  };
  plugin.register(api);
  return { handlers, logger, services };
}

class FakeGatewaySocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.listeners = new Map();
    FakeGatewaySocket.instances.push(this);
  }

  addEventListener(name, handler) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(handler);
    this.listeners.set(name, listeners);
  }

  send(body) {
    this.sent.push(JSON.parse(body));
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code });
  }

  emit(name, event) {
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }

  gateway(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

function gatewayMessage({
  id = MESSAGE,
  content = "NuncaBob should read Ancillary Justice.",
  timestamp = "2026-07-23T20:28:00.000Z",
} = {}) {
  return {
    id,
    guild_id: GUILD,
    channel_id: CHANNEL,
    content,
    timestamp,
    author: {
      id: SENDER,
      username: "optics",
      global_name: "Optics",
      bot: false,
    },
    member: { nick: "Optics" },
  };
}

function readyGateway(socket) {
  socket.gateway({
    op: 10,
    d: { heartbeat_interval: 1_000_000 },
  });
  socket.gateway({
    op: 0,
    s: 1,
    t: "READY",
    d: {
      user: { id: BOT },
      session_id: "session-1",
      resume_gateway_url: "wss://resume.discord.gg",
    },
  });
  socket.gateway({
    op: 0,
    s: 2,
    t: "GUILD_CREATE",
    d: {
      id: GUILD,
      channels: [{ id: CHANNEL, name: "vasttest" }],
      threads: [],
    },
  });
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
    vi.setSystemTime(new Date("2026-07-23T20:28:30.000Z"));
    FakeGatewaySocket.instances = [];
    globalThis.WebSocket = FakeGatewaySocket;
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
    const { handlers, services } = registerObservationPlugin();
    const service = services.get("virtual-context-discord-observer");
    service.start();
    const socket = FakeGatewaySocket.instances[0];
    readyGateway(socket);

    socket.gateway({
      op: 0,
      s: 3,
      t: "MESSAGE_CREATE",
      d: gatewayMessage(),
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

    const invokedId = "1529000000000000002";
    socket.gateway({
      op: 0,
      s: 4,
      t: "MESSAGE_CREATE",
      d: gatewayMessage({
        id: invokedId,
        content: "reply-only invocation",
      }),
    });
    handlers.get("message_received")({
      ...receivedEvent("reply-only invocation"),
      runId: "run-invoked",
      metadata: {
        ...receivedEvent().metadata,
        messageId: invokedId,
      },
    }, messageContext());
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const lateId = "1529000000000000003";
    handlers.get("message_received")({
      ...receivedEvent("late ordering invocation"),
      runId: "run-late",
      metadata: {
        ...receivedEvent().metadata,
        messageId: lateId,
      },
    }, messageContext());
    socket.gateway({
      op: 0,
      s: 5,
      t: "MESSAGE_CREATE",
      d: gatewayMessage({
        id: lateId,
        content: "late ordering invocation",
      }),
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const beforeDispatchId = "1529000000000000004";
    socket.gateway({
      op: 0,
      s: 6,
      t: "MESSAGE_CREATE",
      d: gatewayMessage({
        id: beforeDispatchId,
        content: "host dispatch proof",
      }),
    });
    handlers.get("before_dispatch")({
      body: "host dispatch proof",
      messageId: beforeDispatchId,
      senderId: SENDER,
    }, {
      ...messageContext(),
      accountId: "vast",
      messageId: beforeDispatchId,
      senderId: SENDER,
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    socket.gateway({
      op: 0,
      s: 7,
      t: "MESSAGE_CREATE",
      d: gatewayMessage({
        id: "1529000000000000005",
        content: "stale replay",
        timestamp: "2020-01-01T00:00:00.000Z",
      }),
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    socket.gateway({
      op: 0,
      s: 8,
      t: "MESSAGE_CREATE",
      d: gatewayMessage({
        id: "1529000000000000006",
        content: "stop lifecycle pending",
      }),
    });
    service.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not treat a runless message_received event as dispatch proof", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T20:28:30.000Z"));
    FakeGatewaySocket.instances = [];
    globalThis.WebSocket = FakeGatewaySocket;
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      conversation_id: CONV,
      status: "observed",
      merge_mode: "observation_append",
      canonical_turn_id: "canonical-2",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    globalThis.fetch = fetchSpy;
    const { handlers, services } = registerObservationPlugin();
    const service = services.get("virtual-context-discord-observer");
    service.start();
    const socket = FakeGatewaySocket.instances[0];
    readyGateway(socket);
    socket.gateway({
      op: 0,
      s: 3,
      t: "MESSAGE_CREATE",
      d: gatewayMessage(),
    });

    handlers.get("message_received")(
      receivedEvent(),
      messageContext(),
    );
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    service.stop();
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
