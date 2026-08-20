import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/** Assert at least one ingest actually happened before asserting about them. */
function requireIngestBodies(fetchSpy) {
  const bodies = ingestBodies(fetchSpy);
  expect(bodies.length).toBeGreaterThan(0);
  return bodies;
}

function ingestBodies(fetchSpy) {
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).includes("/api/v1/context/ingest"))
    .map(([, options]) => JSON.parse(options.body ?? "{}"));
}

const NUL = String.fromCharCode(0);

/**
 * Reproduce the shipped record layout on disk from OUTSIDE the module.
 *
 * Deliberately recomputed here rather than imported: a planter that called the
 * same helpers as the reader would agree with it even if both were wrong. This
 * is the second ruler.
 */
function deploymentScope(baseUrl, vcKey) {
  const normalized = new URL(baseUrl).toString().replace(/\/$/, "");
  const vcKeyHash = createHash("sha256").update(vcKey, "utf8").digest("hex");
  return {
    deployment_id: createHash("sha256")
      .update(`${normalized}${NUL}${vcKeyHash}`, "utf8").digest("hex"),
    base_url: normalized,
    vc_key_hash: vcKeyHash,
  };
}

/** Plant a record the startup drain would deliver if it were armed. */
function plantQueuedRecord(
  home, { baseUrl = "https://api.example.com", vcKey = "k" } = {},
) {
  const scope = deploymentScope(baseUrl, vcKey);
  const convId = `sk:${SESSION_KEY}`;
  const identity = {
    platform: "discord", account_id: "vast",
    channel_id: CHANNEL, message_id: MESSAGE,
  };
  const identityKey = [
    identity.platform, identity.account_id,
    identity.channel_id, identity.message_id,
  ].join(NUL);
  const key = createHash("sha256").update(JSON.stringify([
    "outbound-id/v1", scope.deployment_id, convId, identityKey,
  ]), "utf8").digest("hex");
  const dir = join(home, ".openclaw", "state", "virtual-context",
    "outbound-id-queue", scope.deployment_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({
    version: 1, ...scope, key, conv_id: convId, identity,
    observed_at: new Date().toISOString(),
    enqueued_at: new Date().toISOString(),
  }));
  return dir;
}

/** Fail any ingest that carries id metadata; succeed on the bare retry. */
function installMetadataRejectingFetch() {
  const fetchSpy = vi.fn(async (url, options = {}) => {
    const raw = String(options.body ?? "{}");
    if (String(url).includes("/api/v1/context/ingest")
      && raw.includes("observed_outbound_messages")) {
      return new Response("unknown field observed_outbound_messages", {
        status: 400, headers: { "Content-Type": "text/plain" },
      });
    }
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
    const body = JSON.parse(raw);
    return new Response(JSON.stringify({
      conversation_id: "conv", body: { messages: body.messages ?? [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  globalThis.fetch = fetchSpy;
  return fetchSpy;
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

  it("REGRESSION: observe mode does not drain even with a latePath configured", async () => {
    // The startup drain checked only latePath, so switching a deployment to
    // "observe" would have delivered everything already queued and activated
    // suppression -- the opposite of a measurement-only rollout.
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, {
      outboundIdCapture: { mode: "observe", latePath: "/api/v1/outbound-ids" },
    });
    await handlers.get("message_sent")(sentEvent(), sentCtx());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
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
    requireIngestBodies(fetchSpy);
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
    for (const body of requireIngestBodies(fetchSpy)) {
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
    for (const body of requireIngestBodies(fetchSpy)) {
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
    for (const body of requireIngestBodies(fetchSpy)) {
      expect(body).not.toHaveProperty("observed_outbound_messages");
    }
    expect(logText(log)).toContain("NOTHING WILL BE CAPTURED");
    // Assert the REFUSAL directly, not just the empty body. Without the mode
    // gate the id is still captured under sk:<key> while the turn ingests
    // under the session UUID -- damage the ingest body alone cannot show,
    // because it appears only once the late path delivers.
    expect(logText(log)).toContain("conv_identity_session_mode=1");
    expect(logText(log)).toContain("witnessed=0");
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

describe("a metadata rejection must never cost the turn (I-4)", () => {
  it("REGRESSION: retries the ingest WITHOUT metadata when the receiver rejects it", async () => {
    // The metadata rode the ONLY completion request for the turn. An old
    // receiver or a schema rejection would have taken the human's disclosure
    // down with it - metadata failure degrading the turn, which is the one
    // thing this feature is forbidden to cause.
    const home = makeHome();
    const fetchSpy = installMetadataRejectingFetch();
    const { handlers, log } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    await handlers.get("message_sent")(sentEvent(), sentCtx());
    await driveTurn(handlers, turnCtx());

    const bodies = requireIngestBodies(fetchSpy);
    expect(bodies.length).toBe(2);
    expect(bodies[0]).toHaveProperty("observed_outbound_messages");
    // The retry must be the ORIGINAL payload, byte-identical to what would
    // have been sent with the feature switched off.
    expect(bodies[1]).not.toHaveProperty("observed_outbound_messages");
    expect(bodies[1].assistant_message).toBe(bodies[0].assistant_message);
    expect(logText(log)).toContain("RETRYING THE TURN WITHOUT METADATA");
    expect(logText(log)).not.toContain("[vc] ingest failed");
  });

  it("does not double-send when there is no metadata to carry", async () => {
    const home = makeHome();
    const fetchSpy = installMetadataRejectingFetch();
    const { handlers } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    await driveTurn(handlers, turnCtx());
    expect(requireIngestBodies(fetchSpy)).toHaveLength(1);
  });
});

describe("delivery must be armed by BOTH switches", () => {
  it("REGRESSION: observe mode does not drain a queue that already has records", async () => {
    // With an empty queue this passes no matter what, because the drain finds
    // nothing to send. Planting a record first is what makes it discriminate.
    const home = makeHome();
    plantQueuedRecord(home);
    const fetchSpy = installFetch();
    await registerPlugin(home, {
      outboundIdCapture: { mode: "observe", latePath: "/api/v1/outbound-ids" },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const late = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/api/v1/outbound-ids"));
    expect(late).toHaveLength(0);
  });

  it("carry mode WITHOUT a latePath also delivers nothing", async () => {
    const home = makeHome();
    plantQueuedRecord(home);
    const fetchSpy = installFetch();
    await registerPlugin(home, { outboundIdCapture: { mode: "carry" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: carry + latePath DOES deliver the planted record", async () => {
    // Without this, all three tests above would pass against an implementation
    // that can never deliver anything at all.
    const home = makeHome();
    plantQueuedRecord(home);
    const fetchSpy = installFetch();
    await registerPlugin(home, {
      outboundIdCapture: { mode: "carry", latePath: "/api/v1/outbound-ids" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const late = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/api/v1/outbound-ids"));
    expect(late.length).toBeGreaterThan(0);
    const body = JSON.parse(late[0][1].body);
    expect(body.observed_outbound_messages[0].message_id).toBe(MESSAGE);
  });
});

describe("pending ids may not cross a VC credential boundary", () => {
  const AGENT_A_KEY = `agent:alpha:discord:direct:${CHANNEL}`;
  const AGENT_B_KEY = `agent:beta:discord:direct:${CHANNEL}`;
  const GROUP_KEY = `agent:alpha:discord:guild:1524917037191925871`;
  const BETA_KEY = `vc-${"b".repeat(40)}`;

  function groupedConfig(home) {
    const keyFile = join(home, "beta.key");
    writeFileSync(keyFile, `${BETA_KEY}\n`);
    return {
      convIdentity: "stable",
      agentKeyFiles: { beta: keyFile },
      conversationGroups: { [GROUP_KEY]: [AGENT_A_KEY, AGENT_B_KEY] },
      outboundIdCapture: { mode: "carry" },
    };
  }

  const turnFor = (sessionKey, runId) => ({
    sessionId: SESSION, sessionKey, model: "openai-codex/gpt-5.5", runId,
  });

  it("REGRESSION: an id witnessed under key A does not ride key B's ingest", async () => {
    // conversationGroups can map members routed through DIFFERENT agentKeyFiles
    // onto one grouped conv id, while credentials are selected per member
    // session key. Keyed on conv id alone, an identity witnessed under key A
    // rides an ingest authenticated by key B - and with two agents sharing a
    // Discord account and channel the full tuple matches, so a real reply gets
    // suppressed IN THE WRONG TENANT.
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, groupedConfig(home));

    await handlers.get("message_sent")(
      sentEvent({ sessionKey: AGENT_A_KEY }),
      sentCtx({ sessionKey: AGENT_A_KEY }),
    );
    await driveTurn(handlers, turnFor(AGENT_B_KEY, "run-beta"));

    const betaIngests = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/api/v1/context/ingest")
      && String(url).includes(`vckey=${BETA_KEY}`));
    expect(betaIngests.length).toBeGreaterThan(0);
    for (const [, options] of betaIngests) {
      expect(JSON.parse(options.body))
        .not.toHaveProperty("observed_outbound_messages");
    }
  });

  it("POSITIVE CONTROL: the same id DOES ride its own credential's ingest", async () => {
    // Without this, the test above passes against an implementation that never
    // carries anything for a grouped conversation at all.
    const home = makeHome();
    const fetchSpy = installFetch();
    const { handlers } = await registerPlugin(home, groupedConfig(home));

    await handlers.get("message_sent")(
      sentEvent({ sessionKey: AGENT_A_KEY }),
      sentCtx({ sessionKey: AGENT_A_KEY }),
    );
    await driveTurn(handlers, turnFor(AGENT_A_KEY, "run-alpha"));

    const alphaIngests = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/api/v1/context/ingest")
      && String(url).includes("vckey=k&"));
    expect(alphaIngests.length).toBeGreaterThan(0);
    const carried = alphaIngests
      .map(([, options]) => JSON.parse(options.body))
      .filter((body) => body.observed_outbound_messages);
    expect(carried.length).toBeGreaterThan(0);
    expect(carried[0].observed_outbound_messages[0].message_id).toBe(MESSAGE);
  });
});

describe("counters are process-wide, not per registration", () => {
  it("REGRESSION: two registrations in ONE module instance share one counter", async () => {
    // register() runs once per AGENT CONTEXT, not once per process -- measured
    // on prod: three calls, one PID. Per-registration stats produce three
    // independent counters printing three interleaved reports into one journal,
    // each with its own N. A reader adds them, or mistakes one for the total.
    //
    // Every other test here calls vi.resetModules() before registering, which
    // hands each registration a FRESH module and hides this entirely. This test
    // deliberately does not, which is the only reason it can see the bug.
    const home = makeHome();
    installFetch();
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual("node:os");
      return { ...actual, homedir: () => home };
    });
    const mod = await import("../index.js");

    const register = () => {
      const handlers = new Map();
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      mod.default.register({
        logger: log,
        pluginConfig: {
          vcKey: "k", baseUrl: "https://api.example.com",
          convIdentity: "stable", outboundIdCapture: { mode: "observe" },
        },
        config: {}, registerTool: vi.fn(),
        on: vi.fn((name, handler) => handlers.set(name, handler)),
      });
      return { handlers, log };
    };

    const first = register();
    const second = register();

    // One event through the first registration...
    await first.handlers.get("message_sent")(sentEvent(), sentCtx());
    expect(logText(first.log)).toContain("events=1");

    // ...then 24 through the second. The periodic report fires at 25, and it
    // can only reach 25 if the counter is shared: per-registration counters
    // would leave the second at 24 and print nothing at all.
    for (let i = 0; i < 24; i += 1) {
      await second.handlers.get("message_sent")(
        sentEvent({ messageId: `152900000000000${String(1000 + i)}` }), sentCtx(),
      );
    }

    const text = logText(second.log);
    expect(text).toContain("events=25");
    expect(text).toContain("witnessed=25");
    expect(text).toContain("registrations=2");
    // And the first registration never saw a second report of its own.
    expect(logText(first.log)).not.toContain("events=25");
  });
});

describe("a receiver can reject inside a 200", () => {
  function installLatePathFetch(payload, status = 200) {
    const fetchSpy = vi.fn(async (url) => {
      if (String(url).includes("/api/v1/outbound-ids")) {
        return new Response(JSON.stringify(payload), {
          status, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ conversation_id: "conv", status: "ok" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchSpy;
    return fetchSpy;
  }

  const armed = { mode: "carry", latePath: "/api/v1/outbound-ids" };
  const remaining = (dir) =>
    (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".json"));

  it("REGRESSION: a retryable rejection in a 200 body keeps the record", async () => {
    // HTTP 200 is metadata, not evidence of acceptance. Unlinking on a 200 that
    // says "rejected" silently discards a witnessed identity and reports it as
    // delivered -- loss that leaves no trace anywhere.
    const home = makeHome();
    const dir = plantQueuedRecord(home);
    const fetchSpy = installLatePathFetch({
      status: "rejected", reason: "store_unavailable",
    });
    await registerPlugin(home, { outboundIdCapture: armed });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fetchSpy.mock.calls.some(([url]) =>
      String(url).includes("/api/v1/outbound-ids"))).toBe(true);
    expect(remaining(dir)).toHaveLength(1);
  });

  it("drops the record on a permanent reason named by the engine", async () => {
    const home = makeHome();
    const dir = plantQueuedRecord(home);
    installLatePathFetch({ status: "rejected", reason: "conversation_deleted" });
    const { log } = await registerPlugin(home, { outboundIdCapture: armed });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(remaining(dir)).toHaveLength(0);
    expect(logText(log)).toContain("DROPPED permanently-rejected record");
  });

  it("POSITIVE CONTROL: an accepted status DOES unlink the record", async () => {
    const home = makeHome();
    const dir = plantQueuedRecord(home);
    installLatePathFetch({ status: "accepted" });
    await registerPlugin(home, { outboundIdCapture: armed });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(remaining(dir)).toHaveLength(0);
  });
});

describe("a diagnostic may never stop the plugin loading", () => {
  it("REGRESSION: an unreadable queue root is reported, not thrown", async () => {
    // inventoryOutboundIdQueues runs synchronously during registration. An
    // unguarded throw there would stop the plugin loading at all - a metadata
    // report taking down memory for every conversation on the host.
    const home = makeHome();
    const stateDir = join(home, ".openclaw", "state", "virtual-context");
    mkdirSync(stateDir, { recursive: true });
    // A FILE where the queue directory belongs: readdirSync raises ENOTDIR.
    writeFileSync(join(stateDir, "outbound-id-queue"), "not a directory");
    installFetch();
    const { handlers, log } = await registerPlugin(home, {
      outboundIdCapture: { mode: "carry" },
    });
    expect(handlers.has("message_sent")).toBe(true);
    const text = logText(log);
    expect(text).toContain("SCAN FAILED");
    expect(text).toContain("not health");
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
    // No legacy ingest fires for this scope at all: the exact-admission handoff
    // owns the completion. Asserting the absence explicitly keeps this test
    // from passing for the wrong reason if that ever changes.
    expect(ingestBodies(fetchSpy)).toHaveLength(0);
    for (const [, options] of fetchSpy.mock.calls) {
      expect(String(options?.body ?? ""))
        .not.toContain("observed_outbound_messages");
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
