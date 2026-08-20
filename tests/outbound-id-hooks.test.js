import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The pure-function suite proves the parts. This one proves the WIRING: that
// the hook is registered at all, that the gate is actually consulted at
// runtime, and that the tuple reaches the ingest body. A green unit suite over
// helpers nobody calls is the classic way to ship a feature that does nothing.

const SESSION = "11111111-2222-4333-8444-555555555555";
const CHANNEL = "1524946242499514418";
const MESSAGE = "1529000000000000001";
// A Discord DM: stable, and NOT a group scope, so its completion goes down
// the legacy ingest where the fast path lives. Guild channels take a
// different route entirely - see the exact-admission block below.
const SESSION_KEY = `agent:vast:discord:direct:${CHANNEL}`;
const GUILD_CHANNEL_KEY = `agent:vast:discord:channel:${CHANNEL}`;

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
  const home = mkdtempSync(join(tmpdir(), "vc-outbound-id-"));
  mkdirSync(join(home, ".openclaw", "extensions", "virtual-context"), {
    recursive: true,
  });
  createdHomes.push(home);
  return home;
}

function installFetch() {
  const fetchSpy = vi.fn(async (url, options = {}) => {
    if (String(url).includes("/api/v1/context/capabilities")) {
      return new Response(JSON.stringify({ exact_source_admission_version: 2 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).includes("/api/v1/context/ingest")) {
      return new Response(JSON.stringify({ conversation_id: "conv", status: "ok" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    const body = JSON.parse(options.body ?? "{}");
    return new Response(JSON.stringify({
      conversation_id: "conv",
      body: { messages: body.messages ?? [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  globalThis.fetch = fetchSpy;
  return fetchSpy;
}

async function registerPlugin(home, pluginConfig = {}) {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual("node:os");
    return { ...actual, homedir: () => home };
  });
  const mod = await import("../index.js");
  const handlers = new Map();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  mod.default.register({
    logger: log,
    pluginConfig: {
      vcKey: "k",
      baseUrl: "https://api.example.com",
      convIdentity: "stable",
      ...pluginConfig,
    },
    config: {},
    registerTool: vi.fn(),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  });
  return { handlers, log };
}

const sentEvent = (over = {}) => ({
  success: true,
  messageId: MESSAGE,
  content: "the assistant's own words",
  sessionKey: SESSION_KEY,
  ...over,
});

const sentCtx = (over = {}) => ({
  channelId: "discord",
  accountId: "vast",
  conversationId: `channel:${CHANNEL}`,
  sessionKey: SESSION_KEY,
  ...over,
});

const turnCtx = () => ({
  sessionId: SESSION,
  sessionKey: SESSION_KEY,
  model: "openai-codex/gpt-5.5",
  runId: "run-1",
});

async function driveTurn(handlers, ctx) {
  await handlers.get("before_prompt_build")({ prompt: "hi", messages: [] }, ctx);
  await handlers.get("agent_end")({
    runId: ctx.runId,
    success: true,
    messages: [{ role: "assistant", content: [{ type: "text", text: "a reply" }] }],
  }, ctx);
}

function ingestBodies(fetchSpy) {
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).includes("/api/v1/context/ingest"))
    .map(([, options]) => JSON.parse(options.body ?? "{}"));
}

const logText = (log) => [...log.info.mock.calls, ...log.warn.mock.calls]
  .map((call) => String(call[0])).join("\n");

describe("message_sent wiring", () => {
  it("registers NO hook when the feature is off, so an unconfigured deploy is untouched", async () => {
    const home = makeHome();
    installFetch();
    for (const config of [{}, { outboundIdCapture: { mode: "off" } }]) {
      const { handlers } = await registerPlugin(home, config);
      expect(handlers.has("message_sent")).toBe(false);
      expect(handlers.has("message_sending")).toBe(true);
    }
  });

  it("registers the hook in observe mode and makes no network call of its own", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers, log } = await registerPlugin(home, {
      outboundIdCapture: { mode: "observe" },
    });
    expect(handlers.has("message_sent")).toBe(true);
    await handlers.get("message_sent")(sentEvent(), sentCtx());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logText(log)).toContain("[vc:outbound-id] report");
    expect(logText(log)).toContain("witnessed=1");
  });

  it("prints the report on the FIRST firing, because that is what calibrates it", async () => {
    const home = makeHome();
    installFetch();
    const { handlers, log } = await registerPlugin(home, {
      outboundIdCapture: { mode: "observe" },
    });
    expect(logText(log)).not.toContain("[vc:outbound-id] report");
    await handlers.get("message_sent")(sentEvent(), sentCtx());
    expect(logText(log)).toContain("[vc:outbound-id] report");
    expect(logText(log)).toContain("capture_rate=UNKNOWN");
  });

  it("survives a hostile event without throwing: metadata may never cost a turn (I-4)", async () => {
    const home = makeHome();
    installFetch();
    const { handlers } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    const hook = handlers.get("message_sent");
    for (const [event, ctx] of [
      [null, null], [undefined, undefined], [{}, {}],
      [sentEvent({ messageId: { nope: 1 } }), sentCtx()],
      [sentEvent(), { channelId: 123, accountId: [], conversationId: {} }],
      [sentEvent({ sessionKey: "bad" }), sentCtx()],
    ]) {
      expect(() => hook(event, ctx)).not.toThrow();
    }
  });
});

describe("fast path reaches the ingest body", () => {
  it("carries the witnessed tuple on the next ingest for that conversation", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    await handlers.get("message_sent")(sentEvent(), sentCtx());
    await driveTurn(handlers, turnCtx());

    const bodies = ingestBodies(fetchSpy);
    expect(bodies.length).toBeGreaterThan(0);
    const observed = bodies.at(-1).observed_outbound_messages;
    expect(observed).toEqual([{
      platform: "discord",
      account_id: "vast",
      channel_id: CHANNEL,
      message_id: MESSAGE,
      observed_at: expect.any(String),
    }]);
  });

  it("never puts the outbound message content on the wire", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    await handlers.get("message_sent")(sentEvent(), sentCtx());
    await driveTurn(handlers, turnCtx());
    for (const [, options] of fetchSpy.mock.calls) {
      expect(String(options?.body ?? "")).not.toContain("the assistant's own words");
    }
  });

  it("observe mode captures but adds NOTHING to the ingest body", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, {
      outboundIdCapture: { mode: "observe" },
    });
    await handlers.get("message_sent")(sentEvent(), sentCtx());
    await driveTurn(handlers, turnCtx());
    for (const body of ingestBodies(fetchSpy)) {
      expect(body).not.toHaveProperty("observed_outbound_messages");
    }
  });

  it("emits no field at all when nothing was witnessed: an empty list is unknown", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    await driveTurn(handlers, turnCtx());
    for (const body of ingestBodies(fetchSpy)) {
      expect(body).not.toHaveProperty("observed_outbound_messages");
    }
  });

  it("binds to the conversation, not the turn: an id witnessed before the turn still rides it", async () => {
    // runId is not plumbed through the outbound path, so there is no turn join
    // available and none is faked. Set membership per conversation is the whole
    // requirement, and this is what proves the reframe actually holds.
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    await handlers.get("message_sent")(sentEvent({ runId: undefined }), sentCtx());
    await driveTurn(handlers, { ...turnCtx(), runId: "a-completely-different-run" });
    expect(ingestBodies(fetchSpy).at(-1).observed_outbound_messages).toHaveLength(1);
  });
});

describe("the conversation gate is consulted at runtime (codex P0-3)", () => {
  it("REGRESSION: session-mode captures nothing and the ingest body is untouched", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers, log } = await registerPlugin(home, {
      convIdentity: "session",
      outboundIdCapture: { mode: "carry" },
    });
    await handlers.get("message_sent")(sentEvent(), sentCtx());
    await driveTurn(handlers, turnCtx());
    for (const body of ingestBodies(fetchSpy)) {
      expect(body).not.toHaveProperty("observed_outbound_messages");
    }
    expect(logText(log)).toContain("NOTHING WILL BE CAPTURED");
  });

  it("says at boot that a session-mode zero is UNCOVERED, not health", async () => {
    const home = makeHome();
    installFetch();
    const { log } = await registerPlugin(home, {
      convIdentity: "session",
      outboundIdCapture: { mode: "observe" },
    });
    const text = logText(log);
    expect(text).toContain("[vc:outbound-id] enabled");
    expect(text).toContain("UNCOVERED");
  });

  it("refuses an ephemeral scope rather than inventing a conversation", async () => {
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers, log } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    const key = "agent:vast:cron:nightly";
    await handlers.get("message_sent")(
      sentEvent({ sessionKey: key }), sentCtx({ sessionKey: key }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    await handlers.get("message_sent")(sentEvent(), sentCtx());
    expect(logText(log)).toContain("unstable_conv_identity=1");
  });

  it("reports Telegram as an UNCOVERED population by name", async () => {
    const home = makeHome();
    installFetch();
    const { handlers, log } = await registerPlugin(home, {
      outboundIdCapture: { mode: "observe" },
    });
    await handlers.get("message_sent")(
      sentEvent(), sentCtx({ channelId: "telegram" }),
    );
    const text = logText(log);
    expect(text).toContain("no_channel_ruler:telegram=1");
    expect(text).toContain("witnessed=0");
    expect(text).toContain("UNCOVERED");
  });
});

describe("Discord guild channels do not get the fast path", () => {
  it("DOCUMENTS THE GAP: an exact-admission turn carries no ids on its ingest", async () => {
    // agent:<a>:discord:channel:<id> requires exact source attestation, so its
    // completion goes through queueExactCompletion. That payload is
    // FINGERPRINTED, and re-queuing the same source message with a different
    // fingerprint dead-letters the record and loses the turn - so a
    // time-varying id set must never be folded into it.
    //
    // The consequence is not cosmetic: the incident that motivated this feature
    // happened in a guild channel, so for that exact scope THE LATE PATH IS THE
    // ONLY ROUTE. This test exists so that fact cannot quietly stop being true
    // in either direction.
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    const guildCtx = {
      sessionId: SESSION, sessionKey: GUILD_CHANNEL_KEY,
      model: "openai-codex/gpt-5.5", runId: "run-guild",
    };
    await handlers.get("message_sent")(
      sentEvent({ sessionKey: GUILD_CHANNEL_KEY }),
      sentCtx({ sessionKey: GUILD_CHANNEL_KEY }),
    );
    await driveTurn(handlers, guildCtx);
    for (const body of ingestBodies(fetchSpy)) {
      expect(body).not.toHaveProperty("observed_outbound_messages");
    }
  });

  it("still WITNESSES the guild id, so the late path can deliver it once armed", async () => {
    const home = makeHome();
    installFetch();
    const { handlers, log } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    await handlers.get("message_sent")(
      sentEvent({ sessionKey: GUILD_CHANNEL_KEY }),
      sentCtx({ sessionKey: GUILD_CHANNEL_KEY }),
    );
    expect(logText(log)).toContain("witnessed=1");
  });
});

describe("startup surfaces the queue it can and cannot reach", () => {
  it("prints the inventory when enabled, and says an empty disk is not health", async () => {
    const home = makeHome();
    installFetch();
    const { log } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    const text = logText(log);
    expect(text).toContain("[vc:outbound-id] queue inventory");
    expect(text).toContain("NOT that delivery is healthy");
  });

  it("prints nothing about outbound ids when the feature is off", async () => {
    const home = makeHome();
    installFetch();
    const { log } = await registerPlugin(home, {});
    expect(logText(log)).not.toContain("[vc:outbound-id]");
  });

  it("reports latePath as NOT configured so a silent late-path is impossible to miss", async () => {
    const home = makeHome();
    installFetch();
    const { handlers, log } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    await handlers.get("message_sent")(sentEvent(), sentCtx());
    const text = logText(log);
    expect(text).toContain("latePath=NOT configured");
    expect(text).toContain("unbackedFast=1");
  });
});
