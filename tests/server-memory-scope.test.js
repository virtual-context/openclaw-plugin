import { describe, expect, it, vi } from "vitest";
import { createServerMemoryScope, memorySourceChannel } from "../server-memory-scope.js";

const A = "710000000000000001";
const B = "710000000000000002";
const C1 = "720000000000000001";
const C2 = "720000000000000002";
const THREAD = "720000000000000003";
const key = (channel, agent = "guide") => `agent:${agent}:discord:channel:${channel}`;
const guild = (id, agent = "guide") => `sk:agent:${agent}:discord:guild:${id}`;
const config = {
  bindings: [{ agentId: "guide", match: { channel: "discord", accountId: "primary" } }],
  channels: { discord: { accounts: { primary: {
    groupPolicy: "allowlist", guilds: { [A]: {}, [B]: {} },
  } } } },
};
function make(overrides = {}) {
  const log = { warn: vi.fn(), info: vi.fn() };
  const lookupChannel = vi.fn();
  const scope = createServerMemoryScope({
    policies: { guide: "server" }, config, log, lookupChannel,
    legacyIdentity: (sessionKey, sessionId) => ({ convId: sessionKey ? `sk:${sessionKey}` : sessionId, isStable: true }),
    ...overrides,
  });
  return { scope, lookupChannel, log };
}
function receive(scope, channel, server = A, accountId = "primary") {
  scope.observeInbound({ metadata: { provider: "discord", guildId: server, originatingTo: `channel:${channel}` } }, {
    channelId: "discord", accountId, conversationId: `channel:${channel}`,
  });
}

describe("BUG-001: client-owned server memory scope", () => {
  it("groups two channels by proven server even with multiple servers configured", () => {
    const { scope } = make();
    receive(scope, C1); receive(scope, C2); receive(scope, THREAD, B);
    expect(scope.peek(key(C1), "s1")).toMatchObject({ convId: guild(A), channelId: C1, source: "native", policyRevision: 1 });
    expect(scope.peek(key(C2), "s2").convId).toBe(guild(A));
    expect(scope.peek(key(THREAD), "s3").convId).toBe(guild(B));
  });
  it("does not group direct messages or change unconfigured agents", () => {
    const { scope } = make();
    const dm = "agent:guide:discord:direct:730000000000000001";
    expect(scope.peek(dm, "s").convId).toBe(`sk:${dm}`);
    expect(scope.peek(key(C1, "other"), "s").convId).toBe(`sk:${key(C1, "other")}`);
  });
  it("preserves main-session Discord DMs and native ephemeral sessions", () => {
    const { scope } = make();
    for (const sessionKey of ["agent:guide:main", "agent:guide:cron:job", "agent:guide:subagent:run"]) {
      expect(scope.peek(sessionKey, "s", { agentId: "guide", messageChannel: "discord" })).toMatchObject({
        available: true, convId: `sk:${sessionKey}`,
      });
    }
  });
  it("looks up a new thread with its bound account and preserves thread provenance", async () => {
    const { scope, lookupChannel } = make();
    lookupChannel.mockResolvedValue({ id: THREAD, guild_id: A, parent_id: C1 });
    const route = await scope.resolve(key(THREAD), "s", { agentAccountId: "primary", messageChannel: "discord", deliveryContext: { to: `channel:${C1}`, threadId: THREAD } });
    expect(lookupChannel).toHaveBeenCalledExactlyOnceWith("primary", THREAD);
    expect(route).toMatchObject({ convId: guild(A), channelId: THREAD, parentChannelId: C1, source: "lookup" });
    expect(Object.isFrozen(route)).toBe(true);
  });
  it("uses the actual tool factory delivery context for channel provenance", () => {
    expect(memorySourceChannel({ messageChannel: "discord", agentAccountId: "primary", deliveryContext: { channel: "discord", to: `channel:${C1}`, threadId: THREAD } })).toBe(THREAD);
    expect(memorySourceChannel({ messageChannel: "discord", deliveryContext: { to: `discord:channel:${C1}` } })).toBe(C1);
    expect(memorySourceChannel({ channelId: "discord", conversationId: `channel:${C1}` })).toBe(C1);
    expect(memorySourceChannel({ channelId: "discord" })).toBe("");
  });
  it("preserves opaque source channels on other transports", () => {
    expect(memorySourceChannel({ messageChannel: "telegram", channelId: "-1001234567890" },
      "agent:guide:telegram:group:-1001234567890")).toBe("-1001234567890");
  });
  it("fails visibly instead of creating a channel island when membership is unknown", async () => {
    const { scope, log } = make();
    const route = await scope.resolve(key(C1), "s");
    expect(route).toMatchObject({ available: false, convId: null, reason: "membership_unknown" });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("membership_unknown"));
  });
  it("rejects contradictory native memberships without changing a frozen route", () => {
    const { scope } = make();
    receive(scope, C1, A);
    const route = scope.peek(key(C1), "s");
    receive(scope, C1, B);
    expect(scope.peek(key(C1), "s")).toMatchObject({ available: false, reason: "membership_conflict" });
    expect(route.convId).toBe(guild(A));
  });
  it("does not accept unbound accounts or an unallowed server as membership proof", () => {
    const { scope } = make();
    receive(scope, C1, A, "foreign");
    receive(scope, C2, "710000000000000099");
    expect(scope.peek(key(C1), "s").available).toBe(false);
    expect(scope.peek(key(C2), "s").available).toBe(false);
  });
  it("invalidates an earlier proof when a later native observation names an unallowed server", () => {
    const { scope, log } = make(); receive(scope, C1);
    receive(scope, C1, "710000000000000099");
    expect(scope.peek(key(C1), "s")).toMatchObject({ available: false, reason: "membership_conflict" });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("membership_conflict"));
  });
  it("validates exact override targets against actual server membership", () => {
    const groupIndex = new Map([[key(C1), guild(B).slice(3)], [key(C2), guild(A).slice(3)]]);
    const { scope } = make({ groupIndex });
    receive(scope, C1); receive(scope, C2);
    expect(scope.peek(key(C1), "s")).toMatchObject({ available: false, reason: "group_membership_conflict" });
    expect(scope.peek(key(C2), "s")).toMatchObject({ convId: guild(A), source: "explicit+native" });
  });
  it("ignores missing or null native metadata without throwing or inventing membership", () => {
    const { scope } = make();
    for (const metadata of [undefined, null]) {
      expect(() => scope.observeInbound({ metadata }, {
        channelId: "discord", accountId: "primary", conversationId: `channel:${C1}`,
      })).not.toThrow();
    }
    expect(scope.peek(key(C1), "s")).toMatchObject({ available: false, reason: "membership_unknown" });
  });
  it("accepts the native hook platform when duplicate metadata provider fields are absent", () => {
    const { scope } = make();
    scope.observeInbound({ metadata: { guildId: A } }, {
      channelId: "discord", accountId: "primary", conversationId: `channel:${C1}`,
    });
    expect(scope.peek(key(C1), "s").convId).toBe(guild(A));
  });
  it("does not trust guild ids from prompts or arbitrary hook metadata", async () => {
    const { scope } = make();
    expect((await scope.resolve(key(C1), "s", { guildId: A, metadata: { guildId: A } })).available).toBe(false);
  });
  it("backs off failed channel lookups while allowing fresh native proof immediately", async () => {
    let current = 1000;
    const { scope, lookupChannel } = make({ now: () => current });
    lookupChannel.mockResolvedValue(null);
    await scope.resolve(key(C1), "s1");
    await scope.resolve(key(C1), "s2");
    expect(lookupChannel).toHaveBeenCalledTimes(1);
    current += 30_001;
    await scope.resolve(key(C1), "s3");
    expect(lookupChannel).toHaveBeenCalledTimes(2);
    receive(scope, C1);
    expect((await scope.resolve(key(C1), "s4")).convId).toBe(guild(A));
    expect(lookupChannel).toHaveBeenCalledTimes(2);
  });
  it("uses a native slash command's messageThreadId as its physical source", () => {
    expect(memorySourceChannel({ channel: "discord", channelId: C1, messageThreadId: THREAD,
      to: "slash:730000000000000001" }, key(THREAD))).toBe(THREAD);
  });
  it("deduplicates concurrent cold membership lookups", async () => {
    const { scope, lookupChannel } = make();
    lookupChannel.mockResolvedValue({ id: C1, guild_id: A });
    const routes = await Promise.all([scope.resolve(key(C1), "s1"), scope.resolve(key(C1), "s2")]);
    expect(lookupChannel).toHaveBeenCalledTimes(1);
    expect(routes.map(r => r.convId)).toEqual([guild(A), guild(A)]);
  });
  it("revalidates membership on a new process instead of persisting a guessed route", async () => {
    const first = make(); receive(first.scope, C1);
    const second = make();
    expect(second.scope.peek(key(C1), "s").available).toBe(false);
    second.lookupChannel.mockResolvedValue({ id: C1, guild_id: A });
    expect((await second.scope.resolve(key(C1), "s")).convId).toBe(guild(A));
  });
  it("refuses a mismatching channel lookup response", async () => {
    const { scope, lookupChannel } = make();
    lookupChannel.mockResolvedValue({ id: C2, guild_id: A });
    expect((await scope.resolve(key(C1), "s")).available).toBe(false);
  });
  it("rejects conflicting account fields and missing native keys in explicit server mode", () => {
    const { scope } = make(); receive(scope, C1);
    expect(scope.peek(key(C1), "s", { agentAccountId: "primary", accountId: "foreign" }).available).toBe(false);
    expect(scope.peek("", "s", { agentId: "guide", messageChannel: "discord", deliveryContext: { to: `channel:${C1}` } })).toMatchObject({ available: false, reason: "invalid_scope" });
    expect(scope.peek("agent:guide:discord:channel:bad:tail", "s")).toMatchObject({ available: false, reason: "invalid_scope" });
  });
  it("requires session and transport channel identities to agree", () => {
    const { scope } = make(); receive(scope, C1); receive(scope, C2);
    expect(scope.peek(key(C1), "s", { deliveryContext: { to: `channel:${C2}` } })).toMatchObject({ available: false, reason: "channel_conflict" });
  });
});
