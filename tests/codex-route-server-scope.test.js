/** Codex-routed runs of a server-scoped Discord agent use the server conversation. */
import { describe, expect, it, vi } from "vitest";
import { buildProxyModeConfig, createProxyLatches, decideCodexRoute, relatchProxyRun } from "../proxy-mode.js";
import { createServerMemoryScope } from "../server-memory-scope.js";

const KEY = "vc-route-key";
const GUILD = "710000000000000001";
const LISTED = "720000000000000001";
const UNLISTED = "720000000000000009";
const channelKey = (id) => `agent:guide:discord:channel:${id}`;
const serverConv = `sk:agent:guide:discord:guild:${GUILD}`;
const oc = {
  bindings: [{ agentId: "guide", match: { channel: "discord", accountId: "primary" } }],
  channels: { discord: { accounts: { primary: { groupPolicy: "allowlist", guilds: { [GUILD]: {} } } } } },
  models: { providers: { openai: { models: [{ id: "gpt-6.1-sol" }] } } },
  agents: { entries: { guide: { model: { primary: "openai/gpt-6.1-sol" } } } },
};
const good = `https://api.virtual-context.com/${KEY}/backend-api/`;
const toml = `chatgpt_base_url = "${good}"\nmodel_provider = "vc"\n[model_providers.vc]\nname = "OpenAI via Virtual Context"\nbase_url = "${good}codex"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n`;
const config = buildProxyModeConfig({ proxyMode: { enabled: true, codexAgents: { guide: true } } }, oc,
  { pluginBaseUrl: "https://api.virtual-context.com", vcKeyFor: () => KEY, readCodexConfig: () => toml });
// Explicit grouping covers only LISTED; the legacy identity keeps any other channel on its own key.
const groups = new Map([[channelKey(LISTED), `agent:guide:discord:guild:${GUILD}`]]);
const legacy = (sessionKey) => ({ convId: `sk:${groups.get(sessionKey) ?? sessionKey}`, isStable: true });

function scope(lookup = { id: UNLISTED, guild_id: GUILD }) {
  return createServerMemoryScope({ policies: { guide: "server" }, config: oc, groupIndex: groups,
    legacyIdentity: legacy, lookupChannel: vi.fn().mockResolvedValue(lookup), log: { warn: vi.fn(), info: vi.fn() } });
}

describe("BUG-009: codex route under a server memory scope", () => {
  it("sends a channel missing from conversationGroups to the server conversation", async () => {
    const ctx = { sessionKey: channelKey(UNLISTED), sessionId: "s1", runId: "r1" };
    const memoryRoute = await scope().resolve(ctx.sessionKey, ctx.sessionId, ctx);
    const r = decideCodexRoute({ config, ctx, model: "openai/gpt-6.1-sol", runtimeId: null,
      deriveConvIdentity: legacy, groupIndex: groups, latches: createProxyLatches({ ttlMs: 60000 }), memoryRoute });
    expect(r.reason).toBe("routed");
    expect(r.latch.convId).toBe(serverConv);
  });
  it("keeps explicitly grouped channels on the server conversation", async () => {
    const ctx = { sessionKey: channelKey(LISTED), sessionId: "s2", runId: "r2" };
    const memoryRoute = await scope({ id: LISTED, guild_id: GUILD }).resolve(ctx.sessionKey, ctx.sessionId, ctx);
    const r = decideCodexRoute({ config, ctx, model: "openai/gpt-6.1-sol", runtimeId: null,
      deriveConvIdentity: legacy, groupIndex: groups, latches: createProxyLatches({ ttlMs: 60000 }), memoryRoute });
    expect(r.latch.convId).toBe(serverConv);
  });
  it("never falls back to a per-channel conversation when membership cannot be proven", async () => {
    const ctx = { sessionKey: channelKey(UNLISTED), sessionId: "s3", runId: "r3" };
    const memoryRoute = await scope(null).resolve(ctx.sessionKey, ctx.sessionId, ctx);
    expect(memoryRoute.available).toBe(false);
    const latches = createProxyLatches({ ttlMs: 60000 });
    const r = decideCodexRoute({ config, ctx, model: "openai/gpt-6.1-sol", runtimeId: null,
      deriveConvIdentity: legacy, groupIndex: groups, latches, memoryRoute });
    expect(r).toEqual({ latch: null, reason: "scope-unavailable:membership_unknown" });
    expect(latches.size()).toBe(0);
  });
  it("a relatched twin run follows the same scoped route", async () => {
    const twinCfg = { enabled: true, agents: new Map([["guide", { key: KEY, twin: "gpt-6.1-sol-vc", twins: new Set(["gpt-6.1-sol-vc"]) }]]) };
    const ctx = { sessionKey: channelKey(UNLISTED), sessionId: "s4", runId: "r4" };
    const memoryRoute = await scope().resolve(ctx.sessionKey, ctx.sessionId, ctx);
    const re = relatchProxyRun({ config: twinCfg, ctx, latches: createProxyLatches({ ttlMs: 60000 }),
      deriveConvIdentity: legacy, groupIndex: groups, model: "openai/gpt-6.1-sol-vc", memoryRoute });
    expect(re.latch.convId).toBe(serverConv);
  });
});
