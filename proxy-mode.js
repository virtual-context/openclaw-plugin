/**
 * Proxy mode: route an agent's model calls through the VC cloud proxy so VC
 * owns the outbound payload (compaction, stubbing, injection, accounting,
 * ingest) exactly as it does in proxy mode.
 *
 * The switch is a per-run `modelOverride` to a twin catalog entry on the
 * `openai` provider whose baseUrl is the VC route; the conversation identity
 * travels as a signed marker at the head of the current user turn because the
 * host offers no per-run URL or header. Everything here is pure or self-
 * contained so index.js only wires hooks.
 */
import { createHmac } from "node:crypto";

export const ROUTE_MARKER_PREFIX = "<!-- vc:route conversation=";

/** HMAC-SHA256(vcKey, "vc:route:" + convId), first 32 hex chars. */
export function signRouteMarker(vcKey, convId) {
  return createHmac("sha256", String(vcKey)).update(`vc:route:${convId}`, "utf8").digest("hex").slice(0, 32);
}

export function routeMarkerLine(vcKey, convId) {
  return `${ROUTE_MARKER_PREFIX}${convId} sig=${signRouteMarker(vcKey, convId)} -->`;
}

/** One key for a run across every hook: the host's run id alone, which is unique per run
 *  and present in every hook context of that run; empty when the host gave none. */
export function proxyLatchKey(ctx) {
  const runId = typeof ctx?.runId === "string" ? ctx.runId.trim() : "";
  return runId ? JSON.stringify(["run", runId]) : "";
}

export function agentIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return "";
  const parts = sessionKey.split(":");
  return parts[0] === "agent" && parts[1] ? parts[1] : "";
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}

/** The tenant path segment the cloud expects: the key itself when it already carries the vc- prefix. */
export function tenantPathSegment(vcKey) {
  const key = String(vcKey ?? "").trim();
  return key.startsWith("vc-") ? key : `vc-${key}`;
}

/**
 * Normalize and validate the proxyMode block against the host config.
 * Returns { enabled, agents: Map<agentId, {twin, key}>, disabled: [{agent, reason}], healthTimeoutMs, healthTtlMs, latchTtlMs }.
 * Validation per agent: embedded runtime, primary is openai/<real> with twin <real>-vc,
 * fallbacks are twins only, every referenced twin is a well-formed VC-routed catalog entry.
 */
export function buildProxyModeConfig(cfg, ocConfig, { pluginBaseUrl, vcKeyFor, log } = {}) {
  const out = { enabled: false, agents: new Map(), disabled: [], healthTimeoutMs: 1500, healthTtlMs: 60_000, latchTtlMs: 24 * 3_600_000 };
  const pm = cfg?.proxyMode;
  if (!pm || typeof pm !== "object" || Array.isArray(pm)) return out;
  out.enabled = pm.enabled === true;
  for (const [name, def, floor] of [["healthTimeoutMs", 1500, 100], ["healthTtlMs", 60_000, 1000], ["latchTtlMs", 24 * 3_600_000, 3_600_000]]) {
    const v = Number(pm[name]);
    out[name] = Number.isFinite(v) && v >= floor ? v : def;
  }
  if (!out.enabled) return out;
  const agents = pm.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    log?.warn?.("[vc:proxy] proxyMode.agents must be an object of agentId -> twin model id; proxy mode disabled");
    out.enabled = false;
    return out;
  }
  const catalog = ocConfig?.models?.providers?.openai?.models;
  const catalogById = new Map(Array.isArray(catalog) ? catalog.filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]) : []);
  const expectedHost = hostOf(pluginBaseUrl || "");
  for (const [agentIdRaw, twinRaw] of Object.entries(agents)) {
    const agentId = String(agentIdRaw).trim();
    const twin = typeof twinRaw === "string" ? twinRaw.trim() : "";
    const disable = (reason) => {
      out.disabled.push({ agent: agentId, reason });
      log?.warn?.(`[vc:proxy] DISABLED agent=${agentId} reason=${reason}`);
    };
    if (!agentId || !twin) { disable("empty-mapping"); continue; }
    const entry = ocConfig?.agents?.entries?.[agentId];
    if (!entry || typeof entry !== "object") { disable("agent-not-configured"); continue; }
    const key = typeof vcKeyFor === "function" ? vcKeyFor(`agent:${agentId}:main`) : "";
    if (!key) { disable("no-vc-key"); continue; }
    const primary = typeof entry.model === "string" ? entry.model : entry.model?.primary;
    if (typeof primary !== "string" || !primary.startsWith("openai/")) { disable("primary-not-openai"); continue; }
    const real = primary.slice("openai/".length);
    // The host resolves the runtime per agent AND model (agents.entries.<id>.models[<ref>]),
    // then from agents.defaults; an agent entry itself carries no agentRuntime.
    const runtimeId = entry.models?.[primary]?.agentRuntime?.id ?? ocConfig?.agents?.defaults?.agentRuntime?.id;
    if (runtimeId !== "openclaw") { disable(`agentRuntime-not-openclaw:${runtimeId ?? "implicit"}`); continue; }
    if (twin !== `${real}-vc`) { disable(`twin-mismatch:${twin}!=${real}-vc`); continue; }
    const fallbacks = Array.isArray(entry.model?.fallbacks) ? entry.model.fallbacks : [];
    // Fallbacks stay whatever the operator chose. A native fallback inside a
    // routed run is detected at llm_input as a model mismatch, and that run's
    // completion is then ingested by the plugin, not assumed proxied.
    const nativeFallbacks = fallbacks.filter((f) => !(typeof f === "string" && f.startsWith("openai/") && f.endsWith("-vc")));
    if (nativeFallbacks.length) log?.info?.(`[vc:proxy] agent=${agentId} native fallbacks stay native: ${nativeFallbacks.join(", ")}`);
    const twinsToCheck = [twin, ...fallbacks.filter((f) => typeof f === "string" && f.startsWith("openai/") && f.endsWith("-vc")).map((f) => f.slice("openai/".length))];
    let reason = "";
    for (const t of twinsToCheck) {
      const m = catalogById.get(t);
      if (!m) { reason = `twin-missing:${t}`; break; }
      if (m.api !== "openai-chatgpt-responses") { reason = `twin-api:${t}`; break; }
      const wantBase = `https://${expectedHost}/${tenantPathSegment(key)}/backend-api`;
      if (!expectedHost || m.baseUrl !== wantBase) { reason = `twin-baseUrl:${t}`; break; }
      if (m.headers?.["X-VC-Upstream-Model"] !== t.slice(0, -3)) { reason = `twin-upstream-header:${t}`; break; }
      // The live catalog entries the host accepts carry neither field; their
      // absence is reported, not fatal.
      if (m.cost === undefined || m.maxTokens === undefined) log?.info?.(`[vc:proxy] twin ${t} has no cost/maxTokens; the host will use provider defaults`);
    }
    if (reason) { disable(reason); continue; }
    out.agents.set(agentId, { twin, key, twins: new Set(twinsToCheck) });
    log?.info?.(`[vc:proxy] ENABLED agent=${agentId} twin=${twin}`);
  }
  if (out.agents.size === 0) out.enabled = false;
  return out;
}

/**
 * Cached health with background refresh: decisions never wait on the network.
 * state(): "ok" | "down" | "unknown".
 */
export function createProxyHealth({ url, timeoutMs, ttlMs, fetchImpl = globalThis.fetch, now = Date.now, log } = {}) {
  let state = "unknown";
  let checkedAt = 0;
  let inflight = null;
  const refresh = () => {
    if (inflight) return inflight;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    inflight = Promise.resolve()
      .then(() => fetchImpl(url, { method: "GET", signal: controller?.signal }))
      .then((res) => { state = res && res.ok ? "ok" : "down"; })
      .catch(() => { state = "down"; })
      .finally(() => { clearTimeout(timer); checkedAt = now(); inflight = null; });
    return inflight;
  };
  return {
    state: () => state,
    /** Decide from cache; kick a refresh when stale. */
    decide() {
      if (now() - checkedAt >= ttlMs) void refresh().catch(() => {});
      return state;
    },
    refresh,
    _set(s) { state = s; checkedAt = now(); },
  };
}

/** Per-run latches with TTL; the key is proxyLatchKey(ctx). */
export function createProxyLatches({ ttlMs, now = Date.now } = {}) {
  const map = new Map();
  const sweep = () => {
    const t = now();
    for (const [k, v] of map) if (t - v.at > ttlMs) map.delete(k);
  };
  return {
    /** Refuse to overwrite a live latch: two runs must never share one key. */
    take(key, value) {
      sweep();
      if (!key) return false;
      if (map.has(key)) return false;
      map.set(key, { ...value, at: now(), observed: false, mismatch: false });
      return true;
    },
    /** A hit slides the TTL: a live run keeps its latch however long it runs. */
    get(key) {
      sweep();
      const v = key ? map.get(key) : undefined;
      if (v) v.at = now();
      return v;
    },
    delete(key) { if (key) map.delete(key); },
    size() { sweep(); return map.size; },
  };
}

/** Decide the override for one run. Returns { override, reason }. */
export function decideProxyOverride({ config, ctx, health, sessionIngested, deriveConvIdentity, groupIndex, latches, prompt }) {
  if (!config?.enabled) return { override: null, reason: "disabled" };
  const agentId = agentIdFromSessionKey(ctx?.sessionKey);
  const agent = config.agents.get(agentId);
  if (!agent) return { override: null, reason: "agent-not-enabled" };
  const key = proxyLatchKey(ctx);
  if (typeof prompt === "string" && /^\s*VC[A-Z]/i.test(prompt)) {
    latches.delete(key);
    return { override: null, reason: "vc-command" };
  }
  if (!key) return { override: null, reason: "no-run-key" };
  const existing = latches.get(key);
  if (existing) return { override: existing.twin, reason: "selected-again", latchKey: key, convId: existing.convId };
  if (!sessionIngested) return { override: null, reason: "initial-ingest-pending" };
  const identity = deriveConvIdentity(ctx?.sessionKey, ctx?.sessionId, groupIndex);
  if (!identity?.isStable || typeof identity.convId !== "string" || !identity.convId.startsWith("sk:")) {
    return { override: null, reason: "unstable-identity" };
  }
  if (health.decide() !== "ok") return { override: null, reason: "health" };
  const sig = signRouteMarker(agent.key, identity.convId);
  latches.take(key, { twin: agent.twin, twins: agent.twins ?? new Set([agent.twin]), convId: identity.convId, sig, key: agent.key });
  return { override: agent.twin, reason: "selected", latchKey: key, convId: identity.convId };
}

/** Record one model call against the run's latch; a non-twin call marks a mismatch. */
export function observeProxyModelCall(latch, model) {
  if (!latch) return;
  const twins = latch.twins ?? new Set([latch.twin]);
  if (twins.has(model)) latch.observed = true;
  else latch.mismatch = true;
}

/** The plugin skips its own ingest only when every observed call went to the twin. */
export function proxyOwnsIngest(latch) {
  return Boolean(latch && latch.observed && !latch.mismatch);
}
