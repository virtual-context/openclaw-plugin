/** Proxy mode: config validation, latch key, signed marker, health cache, override decision. */
import { describe, it, expect } from "vitest";
import {
  tenantPathSegment,
  buildProxyModeConfig, createProxyHealth, createProxyLatches, decideProxyOverride, warmProxyHealth,
  proxyLatchKey, relatchProxyRun, routeMarkerLine, signRouteMarker, decideCodexRoute,
} from "../proxy-mode.js";

const KEY = "vc-route-key";
const twin = (id, real) => ({ id, api: "openai-chatgpt-responses", baseUrl: `https://api.virtual-context.com/${KEY}/backend-api`,
  headers: { "X-VC-Upstream-Model": real }, cost: { input: 1, output: 2 }, maxTokens: 1000, reasoning: true, input: ["text"] });
const ocConfig = (over = {}) => ({
  models: { providers: { openai: { models: [{ id: "gpt-6-astra" }, twin("gpt-6-astra-vc", "gpt-6-astra"), twin("gpt-5.6-sol-vc", "gpt-5.6-sol")] } } },
  agents: { entries: { bast: { models: { "openai/gpt-6-astra": { agentRuntime: { id: "openclaw" } }, "openai/gpt-6-astra-vc": { params: { transport: "sse" } }, "openai/gpt-5.6-sol-vc": { params: { transport: "sse" } } }, model: { primary: "openai/gpt-6-astra", fallbacks: ["openai/gpt-5.6-sol-vc"] }, ...over } } },
});
const build = (cfg, oc = ocConfig()) => buildProxyModeConfig(cfg, oc, { pluginBaseUrl: "https://api.virtual-context.com", vcKeyFor: () => KEY });

describe("buildProxyModeConfig", () => {
  it("enables a fully validated agent", () => {
    const c = build({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc" } } });
    expect(c.enabled).toBe(true);
    expect(c.agents.get("bast")).toMatchObject({ twin: "gpt-6-astra-vc", key: KEY });
    expect([...c.agents.get("bast").twins]).toEqual(["gpt-6-astra-vc", "gpt-5.6-sol-vc"]);
  });
  it.each([
    ["agentRuntime-not-openclaw:auto", { models: { "openai/gpt-6-astra": { agentRuntime: { id: "auto" } } } }],
    ["agentRuntime-not-openclaw:implicit", { models: {} }],
    ["primary-not-openai", { model: { primary: "minimax/MiniMax-M2.7" } }],
    ["twin-transport-not-sse:gpt-6-astra-vc", { models: { "openai/gpt-6-astra": { agentRuntime: { id: "openclaw" } } } }],
    ["twin-transport-not-sse:gpt-5.6-sol-vc", { models: { "openai/gpt-6-astra": { agentRuntime: { id: "openclaw" } }, "openai/gpt-6-astra-vc": { params: { transport: "sse" } } } }],
    ["twin-mismatch:gpt-6-astra-vc!=gpt-5.6-sol-vc", { model: { primary: "openai/gpt-5.6-sol" }, models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } } }],
  ])("disables with reason %s", (reason, over) => {
    const c = build({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc" } } }, ocConfig(over));
    expect(c.enabled).toBe(false);
    expect(c.disabled).toEqual([{ agent: "bast", reason }]);
  });
  it("disables when the twin entry is malformed", () => {
    const oc = ocConfig();
    oc.models.providers.openai.models[1].baseUrl = "https://elsewhere.example/vc-x/backend-api";
    expect(build({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc" } } }, oc).disabled[0].reason).toBe("twin-baseUrl:gpt-6-astra-vc");
    const oc2 = ocConfig(); delete oc2.models.providers.openai.models[1].maxTokens; delete oc2.models.providers.openai.models[1].cost;
    expect(build({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc" } } }, oc2).enabled).toBe(true);  // reported, not fatal
  });
  it("is off without the block or when disabled", () => {
    expect(build({}).enabled).toBe(false);
    expect(build({ proxyMode: { enabled: false, agents: { bast: "gpt-6-astra-vc" } } }).enabled).toBe(false);
  });
});

describe("latch key and marker", () => {
  it("is the host run id alone, identical from any hook context shape", () => {
    expect(proxyLatchKey({ sessionKey: "agent:bast:main", runId: "r1" })).toBe(JSON.stringify(["run", "r1"]));
    expect(proxyLatchKey({ sessionId: "s", runId: "r1" })).toBe(JSON.stringify(["run", "r1"]));
    expect(proxyLatchKey({ sessionKey: "agent:bast:main" })).toBe("");
    expect(proxyLatchKey({ runId: "a|b" })).not.toBe(proxyLatchKey({ runId: "a" }));
  });
  it("signs the conversation with the tenant key", () => {
    const line = routeMarkerLine(KEY, "sk:agent:bast:main");
    expect(line).toBe(`<!-- vc:route conversation=sk:agent:bast:main sig=${signRouteMarker(KEY, "sk:agent:bast:main")} -->`);
    expect(signRouteMarker(KEY, "sk:a")).not.toBe(signRouteMarker("other", "sk:a"));
    expect(signRouteMarker(KEY, "sk:a")).toHaveLength(32);
  });
});

describe("health cache", () => {
  it("decides from cache and refreshes in the background with a deadline", async () => {
    let t = 1000; let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: true }; };
    const h = createProxyHealth({ url: "http://x/health", timeoutMs: 50, ttlMs: 100, fetchImpl, now: () => t });
    expect(h.decide()).toBe("unknown");        // first decision never waits
    await h.refresh();
    expect(h.state()).toBe("ok");
    t += 50; expect(h.decide()).toBe("ok"); expect(calls).toBe(1);
    t += 100; expect(h.decide()).toBe("ok");   // stale: still answers from cache, refresh kicked
    await h.refresh(); expect(calls).toBe(2);
  });
  it("marks down on error or timeout", async () => {
    const h = createProxyHealth({ url: "http://x", timeoutMs: 10, ttlMs: 100, fetchImpl: async () => { throw new Error("nope"); } });
    await h.refresh(); expect(h.state()).toBe("down");
    const slow = createProxyHealth({ url: "http://x", timeoutMs: 10, ttlMs: 100,
      fetchImpl: (u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("abort")))) });
    await slow.refresh(); expect(slow.state()).toBe("down");
  });
});

describe("warmProxyHealth", () => {
  it("probes each configured key once so the first routed decision is not unknown", async () => {
    const config = build({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc", vast: "gpt-6-astra-vc" } } });
    const h = createProxyHealth({ url: "x", timeoutMs: 50, ttlMs: 1e6, fetchImpl: async () => ({ ok: true }) });
    const seen = [];
    await warmProxyHealth(config, (key) => { seen.push(key); return h; });
    expect(new Set(seen).size).toBe(1);
    expect(seen.length).toBe(1);
    expect(h.decide()).toBe("ok");
  });
  it("swallows probe failures and still resolves", async () => {
    const config = build({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc" } } });
    await expect(warmProxyHealth(config, () => ({ refresh: () => Promise.reject(new Error("down")) }))).resolves.toBeDefined();
    await expect(warmProxyHealth({ agents: new Map() }, () => { throw new Error("never called"); })).resolves.toEqual([]);
  });
});

describe("decideProxyOverride", () => {
  const config = build({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc" } } });
  const ident = (k) => ({ convId: `sk:${k}`, isStable: true });
  const base = () => ({ config, ctx: { sessionKey: "agent:bast:main", sessionId: "s1", runId: "r1" }, sessionIngested: true,
    deriveConvIdentity: ident, groupIndex: new Map(), latches: createProxyLatches({ ttlMs: 1000 }) });
  it("selects the twin and latches the run", () => {
    const h = createProxyHealth({ url: "x", timeoutMs: 1, ttlMs: 1e6, fetchImpl: async () => ({ ok: true }) }); h._set("ok");
    const args = base(); const d = decideProxyOverride({ ...args, health: h });
    expect(d.override).toBe("gpt-6-astra-vc");
    expect(args.latches.get(JSON.stringify(["run", "r1"]))).toMatchObject({ twin: "gpt-6-astra-vc", convId: "sk:agent:bast:main" });
    // the same run resolving again gets the same twin, never a silent native switch
    expect(decideProxyOverride({ ...args, health: h })).toMatchObject({ override: "gpt-6-astra-vc", reason: "selected-again" });
  });
  it.each([
    ["agent-not-enabled", (a) => { a.ctx.sessionKey = "agent:other:main"; }],
    ["no-run-key", (a) => { delete a.ctx.runId; }],
    ["initial-ingest-pending", (a) => { a.sessionIngested = false; }],
    ["unstable-identity", (a) => { a.deriveConvIdentity = () => ({ convId: "uuid", isStable: false }); }],
    ["vc-command", (a) => { a.prompt = "VCSTATUS"; }],
  ])("bypasses with reason %s", (reason, mutate) => {
    const h = createProxyHealth({ url: "x", timeoutMs: 1, ttlMs: 1e6, fetchImpl: async () => ({ ok: true }) }); h._set("ok");
    const args = base(); mutate(args);
    const d = decideProxyOverride({ ...args, health: h });
    expect(d).toMatchObject({ override: null, reason });
    expect(args.latches.size()).toBe(0);
  });
  it("bypasses on unknown or down health without waiting", () => {
    const h = createProxyHealth({ url: "x", timeoutMs: 1, ttlMs: 1e6, fetchImpl: () => new Promise(() => {}) });
    expect(decideProxyOverride({ ...base(), health: h })).toMatchObject({ override: null, reason: "health" });
  });
  it("latches expire only when idle: a hit slides the TTL", () => {
    let t = 0; const l = createProxyLatches({ ttlMs: 10, now: () => t });
    l.take("k", { twin: "x" }); t = 8; expect(l.get("k")).toBeTruthy(); t = 16; expect(l.get("k")).toBeTruthy(); t = 40; expect(l.get("k")).toBeUndefined();
  });
  it("native fallbacks are allowed and reported, not fatal", () => {
    const c = build({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc" } } }, ocConfig({ model: { primary: "openai/gpt-6-astra", fallbacks: ["openai/gpt-5.6-sol"] } }));
    expect(c.enabled).toBe(true);
  });
  it("ownership follows observed calls: twin-only runs skip plugin ingest, mixed runs do not", async () => {
    const { observeProxyModelCall, proxyOwnsIngest } = await import("../proxy-mode.js");
    const latch = { twin: "gpt-6-astra-vc", observed: false, mismatch: false };
    expect(proxyOwnsIngest(latch)).toBe(false);          // nothing observed yet
    observeProxyModelCall(latch, "gpt-6-astra-vc"); expect(proxyOwnsIngest(latch)).toBe(true);
    observeProxyModelCall(latch, "gpt-5.6-sol"); expect(proxyOwnsIngest(latch)).toBe(false);
    const multi = { twin: "gpt-6-astra-vc", twins: new Set(["gpt-6-astra-vc", "gpt-5.6-sol-vc"]), observed: false, mismatch: false };
    observeProxyModelCall(multi, "gpt-5.6-sol-vc"); expect(proxyOwnsIngest(multi)).toBe(true);  // a twin fallback is still the proxy
  });
});


describe("vc command after a latch", () => {
  it("clears the run's latch so no marker is injected for the command", () => {
    const config = build({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc" } } });
    const h = createProxyHealth({ url: "x", timeoutMs: 1, ttlMs: 1e6, fetchImpl: async () => ({ ok: true }) }); h._set("ok");
    const latches = createProxyLatches({ ttlMs: 1000 });
    const args = { config, ctx: { sessionKey: "agent:bast:main", runId: "r9" }, sessionIngested: true, deriveConvIdentity: (k) => ({ convId: `sk:${k}`, isStable: true }), groupIndex: new Map(), latches, health: h };
    expect(decideProxyOverride(args).override).toBe("gpt-6-astra-vc");
    expect(decideProxyOverride({ ...args, prompt: "VCSTATUS" })).toMatchObject({ override: null, reason: "vc-command" });
    expect(latches.get(JSON.stringify(["run", "r9"]))).toBeUndefined();
  });
});


describe("tenantPathSegment", () => {
  it("never doubles the vc- prefix", () => {
    expect(tenantPathSegment("vc-abc")).toBe("vc-abc");
    expect(tenantPathSegment("abc")).toBe("vc-abc");
  });
});

describe("relatchProxyRun", () => {
  const cfg = build({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc" } } });
  const stable = () => ({ convId: "sk:agent:bast:main", isStable: true });
  it("rebuilds the route for a twin-model run whose latch is gone", () => {
    const latches = createProxyLatches({ ttlMs: 3600000 });
    const ctx = { sessionKey: "agent:bast:main", sessionId: "s1", runId: "r1" };
    const re = relatchProxyRun({ config: cfg, ctx, latches, deriveConvIdentity: stable, model: "openai/gpt-6-astra-vc" });
    expect(re.reason).toBe("relatched");
    expect(re.latch).toMatchObject({ twin: "gpt-6-astra-vc", convId: "sk:agent:bast:main", key: KEY, sig: signRouteMarker(KEY, "sk:agent:bast:main") });
    expect(latches.get(proxyLatchKey(ctx))).toBe(re.latch);
    const fb = relatchProxyRun({ config: cfg, ctx: { ...ctx, runId: "r2" }, latches, deriveConvIdentity: stable, model: "openai/gpt-5.6-sol-vc" });
    expect(fb.latch).toMatchObject({ twin: "gpt-5.6-sol-vc" });  // a twin fallback is a routed attempt too
  });
  it("ignores native models and refuses to route an unsigned identity", () => {
    const latches = createProxyLatches({ ttlMs: 3600000 });
    const ctx = { sessionKey: "agent:bast:main", sessionId: "s1", runId: "r1" };
    expect(relatchProxyRun({ config: cfg, ctx, latches, deriveConvIdentity: stable, model: "openai/gpt-6-astra" })).toEqual({ latch: null, reason: "" });
    expect(relatchProxyRun({ config: cfg, ctx, latches, deriveConvIdentity: stable, model: "gpt-6-astra-vc" })).toEqual({ latch: null, reason: "" });
    expect(relatchProxyRun({ config: cfg, ctx, latches, deriveConvIdentity: stable, model: "anthropic/gpt-6-astra-vc" })).toEqual({ latch: null, reason: "" });
    expect(relatchProxyRun({ config: cfg, ctx, latches, deriveConvIdentity: () => ({ convId: "s1", isStable: false }), model: "openai/gpt-6-astra-vc" }))
      .toEqual({ latch: null, reason: "unstable-identity" });
    expect(relatchProxyRun({ config: cfg, ctx: { sessionKey: "agent:bast:main" }, latches, deriveConvIdentity: stable, model: "openai/gpt-6-astra-vc" }))
      .toEqual({ latch: null, reason: "no-run-key" });
    expect(latches.size()).toBe(0);
  });
});


describe("codex-harness route", () => {
  const good = `https://api.virtual-context.com/${KEY}/backend-api/`;
  const provider = (url, over = "") => `\n[model_providers.vc]\nname = "OpenAI via Virtual Context"\nbase_url = "${url}codex"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n${over}`;
  const toml = (url, { withProvider = true, providerUrl = url, over = "" } = {}) =>
    `chatgpt_base_url = "${url}"\nmodel_provider = "vc"\n[projects."/x"]\ntrust_level = "trusted"\n` + (withProvider ? provider(providerUrl, over) : "");
  const buildCodex = (cfg, reader, oc = ocConfig()) =>
    buildProxyModeConfig(cfg, oc, { pluginBaseUrl: "https://api.virtual-context.com", vcKeyFor: () => KEY, readCodexConfig: reader });
  it("enables an agent whose codex-home names this tenant's route", () => {
    const c = buildCodex({ proxyMode: { enabled: true, codexAgents: { bast: true } } }, () => toml(good));
    expect(c.enabled).toBe(true);
    expect(c.codexAgents.get("bast")).toEqual({ key: KEY });
    expect(c.agents.size).toBe(0);
  });
  it.each([
    ["codex-config-missing:bast", () => null],
    ["codex-base-url:bast", () => toml("https://chatgpt.com/backend-api/")],
    ["codex-base-url:bast", () => "project_doc_max_bytes = 1\n"],
    ["codex-provider:bast", () => toml(good, { withProvider: false })],
    ["codex-provider:bast", () => toml(good, { providerUrl: "https://chatgpt.com/backend-api/" })],
    ["codex-provider:bast", () => toml(good, { over: "supports_websockets = true\n" })],
    ["codex-provider:bast", () => toml(good).replace("supports_websockets = false", 'supports_websockets = "false"')],
    ["codex-provider:bast", () => toml(good).replace("requires_openai_auth = true", 'requires_openai_auth = "true"')],
  ])("disables with reason %s", (reason, reader) => {
    const c = buildCodex({ proxyMode: { enabled: true, codexAgents: { bast: true } } }, reader);
    expect(c.enabled).toBe(false);
    expect(c.disabled).toEqual([{ agent: "bast", reason }]);
  });
  it("an agent cannot be both twin-routed and codex-routed", () => {
    const c = buildCodex({ proxyMode: { enabled: true, agents: { bast: "gpt-6-astra-vc" }, codexAgents: { bast: true } } }, () => toml(good));
    expect(c.disabled).toEqual([{ agent: "bast", reason: "codex-and-twin" }]);
    expect(c.agents.has("bast")).toBe(true);
  });
  it("latches the run to the real model and never overrides it", () => {
    const c = buildCodex({ proxyMode: { enabled: true, codexAgents: { bast: true } } }, () => toml(good));
    const latches = createProxyLatches({ ttlMs: 3600000 });
    const ctx = { sessionKey: "agent:bast:main", sessionId: "s1", runId: "r1" };
    const stable = () => ({ convId: "sk:agent:bast:main", isStable: true });
    const d = decideProxyOverride({ config: c, ctx, health: { decide: () => "ok" }, sessionIngested: true, deriveConvIdentity: stable, latches, prompt: "hi" });
    expect(d).toEqual({ override: null, reason: "codex-routed" });
    const r = decideCodexRoute({ config: c, ctx, model: "openai/gpt-6-astra", runtimeId: null, deriveConvIdentity: stable, latches });
    expect(r.reason).toBe("routed");
    expect(r.latch).toMatchObject({ twin: "gpt-6-astra", convId: "sk:agent:bast:main", key: KEY, route: "codex" });
    expect(decideCodexRoute({ config: c, ctx, model: "openai/gpt-6-astra", runtimeId: null, deriveConvIdentity: stable, latches }).reason).toBe("latched");
    expect(routeMarkerLine(r.latch.key, r.latch.convId)).toContain("conversation=sk:agent:bast:main");
  });
  it("native fallbacks and embedded-runtime runs are not routed; ephemeral sessions get a signed session id", () => {
    const c = buildCodex({ proxyMode: { enabled: true, codexAgents: { bast: true } } }, () => toml(good));
    const latches = createProxyLatches({ ttlMs: 3600000 });
    const stable = () => ({ convId: "sk:agent:bast:main", isStable: true });
    const ctx = { sessionKey: "agent:bast:main", sessionId: "s1", runId: "r1" };
    expect(decideCodexRoute({ config: c, ctx, model: "anthropic/claude-opus-4-6", runtimeId: null, deriveConvIdentity: stable, latches })).toEqual({ latch: null, reason: "native-model" });
    expect(decideCodexRoute({ config: c, ctx, model: "openai/gpt-6-astra", runtimeId: "openclaw", deriveConvIdentity: stable, latches })).toEqual({ latch: null, reason: "embedded-runtime" });
    expect(decideCodexRoute({ config: c, ctx: { sessionKey: "agent:other:main", sessionId: "s", runId: "r" }, model: "openai/gpt-6-astra", runtimeId: null, deriveConvIdentity: stable, latches })).toEqual({ latch: null, reason: "" });
    const eph = decideCodexRoute({ config: c, ctx: { sessionKey: "agent:bast:cron:x", sessionId: "abc-123", runId: "r9" }, model: "openai/gpt-5.6-sol", runtimeId: null,
      deriveConvIdentity: () => ({ convId: "abc-123", isStable: false }), latches });
    expect(eph.latch).toMatchObject({ twin: "gpt-5.6-sol", convId: "sk:session:abc-123" });
    expect(latches.size()).toBe(1);
  });
  it("names a fallback model a codex agent uses while the cloud is down", () => {
    const oc = ocConfig({ models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "openclaw" } } } });
    const c = buildCodex({ proxyMode: { enabled: true, codexAgents: { bast: "gpt-5.6-terra" } } }, () => toml(good), oc);
    expect(c.codexAgents.get("bast")).toEqual({ key: KEY, fallback: "gpt-5.6-terra" });
  });
  it("drops a fallback that would run on the codex harness, since that goes through the route", () => {
    const oc = ocConfig({ models: { "openai/gpt-5.6-terra": {} } });
    const c = buildCodex({ proxyMode: { enabled: true, codexAgents: { bast: "gpt-5.6-terra" } } }, () => toml(good), oc);
    expect(c.codexAgents.get("bast")).toEqual({ key: KEY });
    expect(c.disabled).toEqual([{ agent: "bast", reason: "codex-fallback-not-embedded:gpt-5.6-terra" }]);
  });
  it("sends a codex agent to its fallback only while the cloud is down", () => {
    const oc = ocConfig({ models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "openclaw" } } } });
    const c = buildCodex({ proxyMode: { enabled: true, codexAgents: { bast: "gpt-5.6-terra" } } }, () => toml(good), oc);
    const latches = createProxyLatches({ ttlMs: 3600000 });
    const ctx = { sessionKey: "agent:bast:main", sessionId: "s1", runId: "r1" };
    const stable = () => ({ convId: "sk:agent:bast:main", isStable: true });
    const decide = (state) => decideProxyOverride({ config: c, ctx, health: { decide: () => state }, sessionIngested: true, deriveConvIdentity: stable, latches, prompt: "hi" });
    expect(decide("down")).toEqual({ override: "gpt-5.6-terra", reason: "codex-cloud-down" });
    expect(decide("ok")).toEqual({ override: null, reason: "codex-routed" });
    expect(decide("unknown")).toEqual({ override: null, reason: "codex-routed" });
    const plain = buildCodex({ proxyMode: { enabled: true, codexAgents: { bast: true } } }, () => toml(good), oc);
    expect(decideProxyOverride({ config: plain, ctx, health: { decide: () => "down" }, sessionIngested: true, deriveConvIdentity: stable, latches, prompt: "hi" }))
      .toEqual({ override: null, reason: "codex-routed" });
  });
  it("warms health for codex agents too", async () => {
    const c = buildCodex({ proxyMode: { enabled: true, codexAgents: { bast: true } } }, () => toml(good));
    const probed = [];
    await warmProxyHealth(c, (key) => ({ refresh: () => { probed.push(key); } }));
    expect(probed).toEqual([KEY]);
  });
  it("leaves a codex-routed run's ingest to the proxy for the whole run", async () => {
    const { observeProxyModelCall, proxyOwnsIngest } = await import("../proxy-mode.js");
    const c = buildCodex({ proxyMode: { enabled: true, codexAgents: { bast: true } } }, () => toml(good));
    const latches = createProxyLatches({ ttlMs: 3600000 });
    const ctx = { sessionKey: "agent:bast:main", sessionId: "s1", runId: "r1" };
    const r = decideCodexRoute({ config: c, ctx, model: "openai/gpt-6-astra", runtimeId: null, deriveConvIdentity: () => ({ convId: "sk:agent:bast:main", isStable: true }), latches });
    observeProxyModelCall(r.latch, "gpt-6-astra");
    expect(r.latch.observed).toBe(true);
    expect(proxyOwnsIngest(r.latch)).toBe(true);
    expect(proxyOwnsIngest({ ...r.latch, observed: false })).toBe(true);
  });
});
