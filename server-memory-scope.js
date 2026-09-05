/** Client-owned Discord memory grouping. Never derives membership from text. */
const POLICY_REVISION = 1;
const MAX_MEMBERSHIPS = 10_000;
const LOOKUP_RETRY_MS = 30_000;
const clean = (value) => typeof value === "string" ? value.trim() : "";
const snowflake = (value) => /^\d{15,24}$/.test(clean(value)) ? clean(value) : "";
const channelId = (value) => /^(?:(?:discord:)?channel:)?(\d{15,24})$/.exec(clean(value))?.[1] ?? "";
const sessionParts = (key) => /^agent:([^:]+):discord:(channel|guild):([^:]+)$/.exec(clean(key));

/** Real tool factories use deliveryContext; message hooks use conversationId. */
export function memorySourceChannel(ctx = {}, sessionKey = "") {
  const delivery = ctx?.deliveryContext ?? {};
  const platform = clean(ctx?.messageChannel ?? ctx?.messageProvider ?? ctx?.channel ?? delivery.channel ?? ctx?.channelId);
  const thread = snowflake(delivery.threadId ?? ctx?.messageThreadId ?? ctx?.threadId);
  if (thread && (!platform || platform === "discord")) return thread;
  const transport = channelId(delivery.to ?? ctx?.conversationId ?? ctx?.to);
  if (transport && (!platform || platform === "discord")) return transport;
  // Older hook contexts expose the physical channel as channelId.
  const physical = snowflake(ctx?.channelId);
  if (physical) return physical;
  const parts = sessionParts(sessionKey);
  if (parts?.[2] === "channel") return snowflake(parts[3]);
  // Other transports use opaque channel identifiers. Keep their existing
  // physical-channel field instead of applying the Discord snowflake ruler.
  return platform !== "discord" && !/^agent:[^:]+:discord:/.test(clean(sessionKey))
    ? clean(ctx?.channelId) : "";
}

export function createServerMemoryScope({
  policies, config, groupIndex = new Map(), legacyIdentity, lookupChannel, log,
  now = () => Date.now(),
}) {
  const enabled = new Set();
  if (policies && typeof policies === "object" && !Array.isArray(policies)) {
    for (const [agent, policy] of Object.entries(policies)) {
      if (agent && policy === "server") enabled.add(agent);
      else log?.warn?.("[vc:scope] invalid discordMemoryScope policy ignored");
    }
  } else if (policies !== undefined) {
    log?.warn?.("[vc:scope] invalid discordMemoryScope configuration ignored");
  }
  const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
  const memberships = new Map();
  const conflicts = new Set();
  const inflight = new Map();
  const failedLookups = new Map();
  const stats = { resolved: 0, unavailable: 0, conflicts: 0, rejected: 0, lookups: 0 };
  const accountsFor = (agent) => [...new Set(bindings.filter(b =>
    b?.agentId === agent && b?.match?.channel === "discord" && clean(b.match.accountId)
  ).map(b => clean(b.match.accountId)))];
  const accountFor = (agent, ctx = {}) => {
    const accounts = accountsFor(agent);
    const asserted = [...new Set([ctx.agentAccountId, ctx.accountId, ctx.deliveryContext?.accountId].map(clean).filter(Boolean))];
    if (asserted.length > 1) return "";
    const exact = asserted[0] ?? "";
    return exact ? (accounts.includes(exact) ? exact : "") : (accounts.length === 1 ? accounts[0] : "");
  };
  const allowed = (account, guild) => {
    const settings = config?.channels?.discord?.accounts?.[account];
    if (!settings || !snowflake(guild) || settings.groupPolicy === "disabled") return false;
    const policy = settings.groupPolicy ?? config?.channels?.discord?.groupPolicy ?? "allowlist";
    const guilds = settings.guilds ?? config?.channels?.discord?.guilds ?? {};
    return policy === "open" || Object.hasOwn(guilds, guild) || Object.hasOwn(guilds, "*");
  };
  const cacheKey = (agent, account, channel) => `${agent}\0${account}\0${channel}`;
  function remember(agent, account, channel, guild, source, parentChannelId = "") {
    if (!enabled.has(agent) || !accountsFor(agent).includes(account) || !snowflake(channel) || !snowflake(guild)) return false;
    const key = cacheKey(agent, account, channel);
    if (conflicts.has(key)) return false;
    const existing = memberships.get(key);
    if (existing && existing.guild !== guild) {
      memberships.delete(key);
      conflicts.add(key);
      stats.conflicts += 1;
      log?.warn?.(`[vc:scope] membership_conflict agent=${agent} account=${account} channel=${channel}`);
      return false;
    }
    if (!allowed(account, guild)) {
      stats.rejected += 1;
      log?.warn?.(`[vc:scope] membership_rejected agent=${agent} account=${account} channel=${channel} rejected=${stats.rejected}`);
      return false;
    }
    if (!existing && memberships.size >= MAX_MEMBERSHIPS) memberships.delete(memberships.keys().next().value);
    failedLookups.delete(key);
    memberships.set(key, Object.freeze({ guild, source,
      parentChannelId: snowflake(parentChannelId) || existing?.parentChannelId || "",
    }));
    return true;
  }
  function routeInputs(sessionKey, ctx) {
    const parts = sessionParts(sessionKey);
    if (!parts) {
      const family = /^agent:([^:]+):discord:([^:]+)/.exec(clean(sessionKey));
      const agent = family?.[1] ?? clean(ctx?.agentId);
      const platform = family ? "discord" : clean(ctx?.messageChannel ?? ctx?.messageProvider ?? ctx?.channel ?? ctx?.deliveryContext?.channel ?? ctx?.channelId);
      if ((family || !clean(sessionKey)) && enabled.has(agent) && platform === "discord" && !["direct", "group"].includes(family?.[2])) {
        return { agent, channel: memorySourceChannel(ctx), reason: "invalid_scope" };
      }
      return null;
    }
    if (!enabled.has(parts[1])) return null;
    const agent = parts[1];
    const account = accountFor(agent, ctx);
    const channel = memorySourceChannel(ctx, sessionKey);
    const nativeChannel = memorySourceChannel(ctx);
    const keyChannel = parts[2] === "channel" ? snowflake(parts[3]) : "";
    const reason = !account ? "account_unknown" : !snowflake(parts[3]) ? "invalid_scope"
      : nativeChannel && keyChannel && nativeChannel !== keyChannel ? "channel_conflict" : "";
    return { agent, account, channel, parts, reason };
  }
  function unavailable(reason, input) {
    return Object.freeze({ available: false, convId: null, isStable: false, reason,
      channelId: input?.channel ?? "", policyRevision: POLICY_REVISION });
  }
  function peek(sessionKey, sessionId, ctx = {}) {
    const input = routeInputs(sessionKey, ctx);
    if (!input) return Object.freeze({ available: true, ...legacyIdentity(sessionKey, sessionId), channelId: memorySourceChannel(ctx, sessionKey) });
    if (input.reason) return unavailable(input.reason, input);
    const { agent, account, channel, parts } = input;
    const key = cacheKey(agent, account, channel);
    if (conflicts.has(key)) return unavailable("membership_conflict", input);
    // A native guild session is already a server identity; when a physical
    // channel is supplied it must still prove membership in that server.
    const member = memberships.get(key) ?? (!channel && parts[2] === "guild" && allowed(account, parts[3])
      ? { guild: parts[3], source: "native-guild", parentChannelId: "" } : null);
    if (!member) return unavailable("membership_unknown", input);
    if (parts[2] === "guild" && parts[3] !== member.guild) return unavailable("group_membership_conflict", input);
    const target = `agent:${agent}:discord:guild:${member.guild}`;
    // Exact group declarations retain priority, but cannot contradict proven
    // membership or move memory to another agent/server in server mode.
    const explicit = groupIndex.get(sessionKey);
    if (explicit && explicit !== target) return unavailable("group_membership_conflict", input);
    return Object.freeze({ available: true, convId: `sk:${target}`, isStable: true,
      channelId: channel, parentChannelId: member.parentChannelId, accountId: account,
      policyRevision: POLICY_REVISION, source: `${explicit ? "explicit+" : ""}${member.source}` });
  }
  async function resolve(sessionKey, sessionId, ctx = {}) {
    let route = peek(sessionKey, sessionId, ctx);
    const input = routeInputs(sessionKey, ctx);
    if (route.reason === "membership_unknown" && input?.channel && lookupChannel) {
      const key = cacheKey(input.agent, input.account, input.channel);
      if (!inflight.has(key) && (failedLookups.get(key) ?? 0) <= now()) {
        const promise = (async () => {
          stats.lookups += 1;
          let admitted = false;
          try {
            const result = await lookupChannel(input.account, input.channel);
            if (result?.id === input.channel) admitted = remember(input.agent, input.account,
              input.channel, result.guild_id, "lookup", result.parent_id);
          } catch {
            // Do not log transport errors: fetch errors may embed credentials.
            log?.warn?.(`[vc:scope] membership_lookup_failed agent=${input.agent} channel=${input.channel}`);
          }
          if (!admitted) {
            failedLookups.set(key, now() + LOOKUP_RETRY_MS);
            while (failedLookups.size > MAX_MEMBERSHIPS) failedLookups.delete(failedLookups.keys().next().value);
          }
        })();
        inflight.set(key, promise);
        promise.finally(() => inflight.delete(key));
      }
      await inflight.get(key);
      route = peek(sessionKey, sessionId, ctx);
    }
    if (route.available) stats.resolved += 1;
    else {
      stats.unavailable += 1;
      log?.warn?.(`[vc:scope] memory scope unavailable reason=${route.reason} agent=${input?.agent ?? "?"} channel=${route.channelId || "?"} bypasses=${stats.unavailable}`);
    }
    return route;
  }
  function observeInbound(event, ctx) {
    const metadata = event?.metadata && typeof event.metadata === "object"
      ? event.metadata : {};
    if (ctx?.channelId !== "discord" || clean(metadata?.provider ?? metadata?.originatingChannel ?? ctx?.channelId) !== "discord") return;
    const account = clean(ctx.accountId);
    const channel = channelId(ctx.conversationId ?? metadata.originatingTo);
    const origin = channelId(metadata.originatingTo);
    if (!channel || (origin && origin !== channel)) return;
    for (const agent of enabled) {
      remember(agent, account, channel, snowflake(metadata.guildId), "native");
    }
  }
  log?.info?.(`[vc:scope] policy=${enabled.size ? "server" : "default"} revision=${POLICY_REVISION} agents=${enabled.size} membershipCache=process-local`);
  return { peek, resolve, observeInbound, stats };
}
