import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDiscordGatewayObserver,
  gatewayMessageToPluginEvent,
} from "../discord-observer.js";

const GUILD = "1524917037191925871";
const CHANNEL = "1524946242499514418";
const BOT = "1485681229608259666";
const SENDER = "387316537012518913";
const MESSAGE = "1529000000000000001";

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
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

function humanMessage(overrides = {}) {
  return {
    id: MESSAGE,
    guild_id: GUILD,
    channel_id: CHANNEL,
    content: "Cedar tea pairs with a brass astrolabe.",
    timestamp: "2026-07-23T20:28:00.000Z",
    author: {
      id: SENDER,
      username: "optics",
      global_name: "Optics",
      bot: false,
    },
    member: { nick: "Optics" },
    ...overrides,
  };
}

function hello(socket, heartbeatInterval = 60_000) {
  socket.gateway({
    op: 10,
    d: { heartbeat_interval: heartbeatInterval },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  FakeSocket.instances = [];
});

describe("receive-only Discord Gateway observer", () => {
  it("normalizes human guild messages and reply provenance, never DMs/bots/webhooks", () => {
    const normalized = gatewayMessageToPluginEvent(humanMessage({
      message_reference: { message_id: "1529000000000000099" },
      referenced_message: {
        id: "1529000000000000099",
        content: "Earlier body",
        author: {
          id: "387316537012518999",
          username: "other",
          global_name: "Other",
        },
      },
    }), {
      botUserId: BOT,
      channelLabel: "vasttest",
    });

    expect(normalized).toMatchObject({
      event: {
        content: "Cedar tea pairs with a brass astrolabe.",
        metadata: {
          guildId: GUILD,
          channelName: "vasttest",
          messageId: MESSAGE,
          senderId: SENDER,
          replyToId: "1529000000000000099",
          replySenderId: "387316537012518999",
        },
      },
      ctx: {
        channelId: "discord",
        conversationId: CHANNEL,
        replyToSender: "Other",
        replyToBody: "Earlier body",
      },
    });

    expect(gatewayMessageToPluginEvent(
      humanMessage({ guild_id: undefined }),
      { botUserId: BOT },
    )).toBeNull();
    expect(gatewayMessageToPluginEvent(
      humanMessage({
        author: { id: SENDER, username: "bot", bot: true },
      }),
      { botUserId: BOT },
    )).toBeNull();
    expect(gatewayMessageToPluginEvent(
      humanMessage({ webhook_id: "1529000000000000088" }),
      { botUserId: BOT },
    )).toBeNull();
    expect(gatewayMessageToPluginEvent(
      humanMessage({
        author: { id: BOT, username: "Vast", bot: false },
      }),
      { botUserId: BOT },
    )).toBeNull();
  });

  it("identifies without presence, forwards MESSAGE_CREATE, and resumes first", async () => {
    vi.useFakeTimers();
    const onMessageCreate = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const observer = createDiscordGatewayObserver({
      token: "secret-token",
      botUserId: BOT,
      onMessageCreate,
      log,
      WebSocketImpl: FakeSocket,
      random: () => 0,
    });

    observer.start();
    const first = FakeSocket.instances[0];
    expect(first.url).toBe(
      "wss://gateway.discord.gg/?v=10&encoding=json",
    );
    hello(first);
    expect(first.sent[0]).toMatchObject({
      op: 2,
      d: {
        token: "secret-token",
        intents: 33281,
      },
    });
    expect(first.sent[0].d).not.toHaveProperty("presence");
    first.gateway({
      op: 0,
      s: 11,
      t: "READY",
      d: {
        user: { id: BOT },
        session_id: "resume-me",
        resume_gateway_url: "wss://resume.discord.gg",
      },
    });
    first.gateway({
      op: 0,
      s: 12,
      t: "GUILD_CREATE",
      d: {
        channels: [{ id: CHANNEL, name: "vasttest" }],
        threads: [],
      },
    });
    first.gateway({
      op: 0,
      s: 13,
      t: "MESSAGE_CREATE",
      d: humanMessage(),
    });
    await Promise.resolve();
    expect(onMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: MESSAGE }),
      { channelLabel: "vasttest" },
    );

    first.close(4000);
    await vi.advanceTimersByTimeAsync(1000);
    const resumed = FakeSocket.instances[1];
    expect(resumed.url).toBe(
      "wss://resume.discord.gg/?v=10&encoding=json",
    );
    hello(resumed);
    expect(resumed.sent[0]).toEqual({
      op: 6,
      d: {
        token: "secret-token",
        session_id: "resume-me",
        seq: 13,
      },
    });
    expect([
      ...first.sent,
      ...resumed.sent,
    ].every((frame) => [1, 2, 6].includes(frame.op))).toBe(true);
    observer.stop();
  });

  it("detects heartbeat zombies and limits fresh IDENTIFY reconnects", async () => {
    vi.useFakeTimers();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const observer = createDiscordGatewayObserver({
      token: "secret-token",
      botUserId: BOT,
      onMessageCreate: vi.fn(),
      log,
      WebSocketImpl: FakeSocket,
      random: () => 0,
      maxIdentifiesPerWindow: 1,
      identifyWindowMs: 300_000,
    });

    observer.start();
    const first = FakeSocket.instances[0];
    hello(first, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("missed heartbeat ACK"),
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("IDENTIFY circuit open"),
    );
    observer.stop();
  });

  it("reconnects a socket that never receives HELLO", async () => {
    vi.useFakeTimers();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const observer = createDiscordGatewayObserver({
      token: "secret-token",
      botUserId: BOT,
      onMessageCreate: vi.fn(),
      log,
      WebSocketImpl: FakeSocket,
      random: () => 0,
      handshakeTimeoutMs: 2000,
    });
    observer.start();
    await vi.advanceTimersByTimeAsync(3000);

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("timed out before HELLO"),
    );
    expect(FakeSocket.instances).toHaveLength(2);
    observer.stop();
  });

  it("clears a non-resumable session on op 9 and identifies afresh", async () => {
    vi.useFakeTimers();
    const observer = createDiscordGatewayObserver({
      token: "secret-token",
      botUserId: BOT,
      onMessageCreate: vi.fn(),
      WebSocketImpl: FakeSocket,
      random: () => 0,
    });
    observer.start();
    const first = FakeSocket.instances[0];
    hello(first);
    first.gateway({
      op: 0,
      s: 9,
      t: "READY",
      d: {
        user: { id: BOT },
        session_id: "invalidated",
        resume_gateway_url: "wss://resume.discord.gg",
      },
    });
    first.gateway({ op: 9, d: false });
    await vi.advanceTimersByTimeAsync(1000);
    const fresh = FakeSocket.instances[1];
    hello(fresh);
    expect(fresh.sent[0].op).toBe(2);
    observer.stop();
  });

  it("rejects malformed HELLO and stops on fatal Gateway close codes", async () => {
    vi.useFakeTimers();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const observer = createDiscordGatewayObserver({
      token: "secret-token",
      botUserId: BOT,
      onMessageCreate: vi.fn(),
      log,
      WebSocketImpl: FakeSocket,
      random: () => 0,
    });
    observer.start();
    const malformed = FakeSocket.instances[0];
    malformed.gateway({ op: 10, d: {} });
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("invalid heartbeat interval"),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const fatal = FakeSocket.instances[1];
    fatal.close(4014);
    expect(observer.state.fatal).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    observer.stop();
  });

  it("stops permanently if READY identifies a different bot", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const observer = createDiscordGatewayObserver({
      token: "secret-token",
      botUserId: BOT,
      onMessageCreate: vi.fn(),
      log,
      WebSocketImpl: FakeSocket,
      random: () => 0,
    });
    observer.start();
    const socket = FakeSocket.instances[0];
    hello(socket);
    socket.gateway({
      op: 0,
      s: 1,
      t: "READY",
      d: {
        user: { id: "1485681229608259000" },
        session_id: "wrong",
        resume_gateway_url: "wss://resume.discord.gg",
      },
    });

    expect(observer.state.fatal).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("bot identity mismatch"),
    );
    expect(FakeSocket.instances).toHaveLength(1);
    observer.stop();
  });
});
