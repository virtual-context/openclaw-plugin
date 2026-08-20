import { describe, it, expect } from "vitest";
import {
  normalizeOutboundIdConfig,
  normalizeOutboundIdentity,
  isExactOutboundIdentity,
  outboundIdentityKey,
  outboundIdRecordKey,
  outboundIdWireProjection,
  outboundConvIdFor,
  rememberPendingOutboundId,
  pendingOutboundIdsForConversation,
  forgetPendingOutboundIds,
  prunePendingOutboundIds,
  outboundIdDueRecords,
  outboundIdQueueOrder,
  enforceOutboundIdQueueBounds,
  outboundIdFailureIsPermanent,
  classifyOutboundIdResponse,
  completionOutboxFingerprint,
  newOutboundIdStats,
  noteOutboundIdRefusal,
  renderOutboundIdReport,
  renderOutboundIdInventory,
} from "../index.js";

const CHANNEL = "123456789012345678";
const OTHER_CHANNEL = "876543210987654321";
const MESSAGE = "999888777666555444";

const discordSent = (overrides = {}) => ({
  event: {
    success: true,
    messageId: MESSAGE,
    content: "the bot's own words, which must never be stored by this feature",
    sessionKey: `agent:vast:discord:channel:${CHANNEL}`,
    ...(overrides.event ?? {}),
  },
  ctx: {
    channelId: "discord",
    accountId: "vast",
    conversationId: `channel:${CHANNEL}`,
    ...(overrides.ctx ?? {}),
  },
});

const identity = (over = {}) => ({
  platform: "discord",
  account_id: "vast",
  channel_id: CHANNEL,
  message_id: MESSAGE,
  ...over,
});

describe("outbound id config", () => {
  it("defaults to off, so an unconfigured deployment changes no byte on the wire", () => {
    for (const raw of [undefined, null, {}, { mode: "" }, { mode: "ON" }, { mode: 1 }]) {
      const cfg = normalizeOutboundIdConfig(raw);
      expect(cfg.mode).toBe("off");
      expect(cfg.enabled).toBe(false);
      expect(cfg.carry).toBe(false);
    }
  });

  it("observe captures without carrying; carry does both", () => {
    expect(normalizeOutboundIdConfig({ mode: "observe" }))
      .toMatchObject({ enabled: true, carry: false });
    expect(normalizeOutboundIdConfig({ mode: "carry" }))
      .toMatchObject({ enabled: true, carry: true });
  });

  it("refuses a latePath that is not a rooted path", () => {
    expect(normalizeOutboundIdConfig({ mode: "carry", latePath: "api/x" }).latePath).toBe("");
    expect(normalizeOutboundIdConfig({ mode: "carry", latePath: 7 }).latePath).toBe("");
    expect(normalizeOutboundIdConfig({ mode: "carry", latePath: "/api/v1/x" }).latePath)
      .toBe("/api/v1/x");
  });
});

describe("identity projection (I-2)", () => {
  it("projects a successful Discord delivery onto the full namespaced tuple", () => {
    const { event, ctx } = discordSent();
    const { identity: got, reason } = normalizeOutboundIdentity(event, ctx);
    expect(reason).toBe("");
    expect(got).toEqual(identity());
  });

  it("NEGATIVE CONTROL: channel_id is the physical channel, never the transport name", () => {
    // ctx.channelId is "discord" -- the transport. Stamping it as channel_id
    // would make every observation share one channel namespace, and the
    // inbound side (origin_channel_id) holds the snowflake, so the two sides
    // could never match. A never-matching set is indistinguishable from an
    // absent one, which is a silent total failure.
    const { event, ctx } = discordSent();
    const { identity: got } = normalizeOutboundIdentity(event, ctx);
    expect(got.channel_id).toBe(CHANNEL);
    expect(got.channel_id).not.toBe("discord");
    expect(got.platform).toBe("discord");
  });

  it("refuses a delivery that did not succeed -- unknown, not negative (I-1)", () => {
    for (const success of [false, undefined, null, "true", 1]) {
      const { event, ctx } = discordSent({ event: { success } });
      const out = normalizeOutboundIdentity(event, ctx);
      expect(out.identity).toBeNull();
      expect(out.reason).toBe("delivery_not_successful");
    }
  });

  it("names every refusal instead of lumping them, so a blind spot is locatable", () => {
    const cases = [
      [discordSent({ event: { messageId: "" } }), "no_message_id"],
      [discordSent({ ctx: { accountId: "" } }), "no_account_id"],
      [discordSent({ ctx: { channelId: "" }, event: { channelId: "" } }), "no_platform"],
      [discordSent({ ctx: { conversationId: "not-a-snowflake" } }), "no_channel_id"],
      [discordSent({ ctx: { channelId: "telegram" } }), "no_channel_ruler:telegram"],
    ];
    for (const [{ event, ctx }, expected] of cases) {
      const out = normalizeOutboundIdentity(event, ctx);
      expect(out.identity).toBeNull();
      expect(out.reason).toBe(expected);
    }
  });

  it("reports Telegram as UNCOVERED by name rather than capturing it on a guess", () => {
    const { event, ctx } = discordSent({ ctx: { channelId: "telegram" } });
    const out = normalizeOutboundIdentity(event, ctx);
    expect(out.reason).toContain("no_channel_ruler");
    expect(out.reason).toContain("telegram");
  });

  it("never reads or returns message content", () => {
    const { event, ctx } = discordSent();
    const { identity: got } = normalizeOutboundIdentity(event, ctx);
    expect(JSON.stringify(got)).not.toContain("the bot's own words");
    expect(Object.keys(got).sort())
      .toEqual(["account_id", "channel_id", "message_id", "platform"]);
  });
});

describe("identity keys are injective (codex P1-5)", () => {
  it("rejects any field carrying a control character, which is what keeps NUL safe", () => {
    // The reported ambiguity was (platform "a\0b", account "c") colliding with
    // (platform "a", account "b\0c"). It cannot be constructed: the exactness
    // check refuses control characters outright.
    expect(isExactOutboundIdentity(identity({ platform: "a\u0000b" }))).toBe(false);
    expect(outboundIdentityKey(identity({ account_id: "a\u0000b" }))).toBe("");
    expect(outboundIdentityKey(identity({ channel_id: "a\nb" }))).toBe("");
    expect(outboundIdRecordKey("dep", "sk:x", identity({ message_id: "a\tb" }))).toBe("");
  });

  it("rejects non-strings, empties, untrimmed values and over-long values", () => {
    expect(isExactOutboundIdentity(identity({ account_id: 42 }))).toBe(false);
    // REGRESSION: cleanInboundField("") returns "", so an empty field
    // round-trips successfully. Without an explicit empty check it was
    // accepted as exact, and an empty component collapses the namespace.
    for (const field of ["platform", "account_id", "channel_id", "message_id"]) {
      expect(isExactOutboundIdentity(identity({ [field]: "" }))).toBe(false);
      expect(outboundIdentityKey(identity({ [field]: "" }))).toBe("");
      expect(outboundIdWireProjection([{ identity: identity({ [field]: "" }) }]))
        .toEqual({});
    }
    expect(isExactOutboundIdentity(identity({ account_id: " vast " }))).toBe(false);
    expect(isExactOutboundIdentity(identity({ message_id: "x".repeat(129) }))).toBe(false);
    expect(isExactOutboundIdentity(identity({ platform: "Discord" }))).toBe(false);
    expect(isExactOutboundIdentity(null)).toBe(false);
    expect(isExactOutboundIdentity(identity())).toBe(true);
  });

  it("distinguishes tuples that differ in ANY namespace component", () => {
    const keys = new Set([
      outboundIdentityKey(identity()),
      outboundIdentityKey(identity({ platform: "telegram" })),
      outboundIdentityKey(identity({ account_id: "other" })),
      outboundIdentityKey(identity({ channel_id: OTHER_CHANNEL })),
      outboundIdentityKey(identity({ message_id: "1" })),
    ]);
    expect(keys.size).toBe(5);
    expect(keys.has("")).toBe(false);
  });

  it("a bare message id is never the identity (I-2)", () => {
    const key = outboundIdentityKey(identity());
    expect(key).not.toBe(MESSAGE);
    expect(key).toContain("discord");
    expect(key).toContain("vast");
    expect(key).toContain(CHANNEL);
  });

  it("record keys are idempotent per (deployment, conversation, identity)", () => {
    const a = outboundIdRecordKey("dep1", "sk:conv", identity());
    expect(a).toBe(outboundIdRecordKey("dep1", "sk:conv", identity()));
    expect(a).not.toBe(outboundIdRecordKey("dep2", "sk:conv", identity()));
    expect(a).not.toBe(outboundIdRecordKey("dep1", "sk:other", identity()));
    // The identity must actually participate. Without this, a key function
    // that ignored the tuple entirely still passed every assertion above.
    for (const field of ["platform", "account_id", "channel_id", "message_id"]) {
      expect(a).not.toBe(
        outboundIdRecordKey("dep1", "sk:conv", identity({ [field]: "zzz" })),
      );
    }
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(outboundIdRecordKey("dep1", "", identity())).toBe("");
  });
});

describe("conversation gate (codex P0-3)", () => {
  const stableKey = `agent:vast:discord:channel:${CHANNEL}`;

  it("REGRESSION: session-mode deployments capture nothing, even for a valid key", () => {
    // deriveConvIdentity is a pure derivation, not a policy: it returns
    // sk:<key> for a Discord-shaped key regardless of configuration. Without
    // the mode gate, base turns would ingest under a rotating session UUID
    // while outbound ids landed on sk:<key> -- a different conversation, and
    // possibly one that already belongs to other traffic.
    expect(outboundConvIdFor(stableKey, { stableMode: false })).toBe("");
    expect(outboundConvIdFor(stableKey, {})).toBe("");
    expect(outboundConvIdFor(stableKey, { stableMode: "stable" })).toBe("");
  });

  it("binds a recognised stable scope in stable mode", () => {
    expect(outboundConvIdFor(stableKey, { stableMode: true })).toBe(`sk:${stableKey}`);
    expect(outboundConvIdFor("agent:vast:main", { stableMode: true }))
      .toBe("sk:agent:vast:main");
  });

  it("refuses ephemeral, malformed and missing keys rather than inventing one", () => {
    for (const key of [
      "", null, undefined, 42, "   ", "not-an-agent-key",
      "agent:vast:cron:nightly", "agent:vast:subagent:abc", "agent:vast:explicit:xyz",
      "agent:vast:discord:unknownscope:1", `agent:vast:web:direct:u1`,
    ]) {
      expect(outboundConvIdFor(key, { stableMode: true })).toBe("");
    }
  });

  it("adopts a conversation group's identity when one is configured", () => {
    const groupKey = "agent:vast:discord:guild:5";
    const groupIndex = new Map([[stableKey, groupKey]]);
    expect(outboundConvIdFor(stableKey, { stableMode: true, groupIndex }))
      .toBe(`sk:${groupKey}`);
  });

  it("never invents a session id: no sessionId is available on this hook", () => {
    // deriveConvIdentity falls back to its sessionId argument on every
    // non-stable branch. The gate passes null, so a fallback can only ever
    // produce "" -- never a per-UUID conversation the ingest path is not using.
    expect(outboundConvIdFor("agent:vast:cron:nightly", { stableMode: true })).toBe("");
  });
});

describe("wire projection (I-1, I-3)", () => {
  it("emits NO completeness bit and NO count a receiver could read as a denominator", () => {
    const body = outboundIdWireProjection([
      { identity: identity(), observed_at: "2026-08-20T00:00:00.000Z" },
    ]);
    expect(Object.keys(body)).toEqual(["_vc_agent_outbound_ids"]);
    // Match FIELD NAMES, not substrings of the serialized blob: "account_id"
    // contains "count", so a substring ruler fails on a correct payload and
    // would have been "fixed" by weakening the check that matters.
    const fieldNames = [
      ...Object.keys(body),
      ...body._vc_agent_outbound_ids.flatMap((row) => Object.keys(row)),
    ];
    // An ALLOWLIST, not a blacklist. A finite forbidden-words list passes
    // anything nobody thought of -- `expected_count`, `denominator` -- which is
    // precisely the field that would let a receiver infer completeness.
    expect(new Set(fieldNames)).toEqual(new Set([
      "_vc_agent_outbound_ids",
      "platform", "account_id", "channel_id", "message_id", "observed_at",
    ]));
    // With a scope supplied, agent_scope_id joins the allowlist and nothing else does.
    const scoped = outboundIdWireProjection(
      [{ identity: identity(), observed_at: "2026-08-20T00:00:00.000Z" }], "vast",
    );
    expect(Object.keys(scoped._vc_agent_outbound_ids[0]).sort()).toEqual([
      "account_id", "agent_scope_id", "channel_id", "message_id",
      "observed_at", "platform",
    ]);
    expect(scoped._vc_agent_outbound_ids[0].agent_scope_id).toBe("vast");
    expect(Object.keys(body._vc_agent_outbound_ids[0]).sort()).toEqual([
      "account_id", "channel_id", "message_id", "observed_at", "platform",
    ]);
  });

  it("emits NOTHING for an empty set: an empty list is unknown, not 'none'", () => {
    expect(outboundIdWireProjection([])).toEqual({});
    expect(outboundIdWireProjection(undefined)).toEqual({});
    expect(outboundIdWireProjection([{ identity: identity({ account_id: "" }) }]))
      .toEqual({});
  });

  it("unions duplicates instead of repeating them (I-3, case A3)", () => {
    const body = outboundIdWireProjection([
      { identity: identity() },
      { identity: identity() },
      { identity: identity({ message_id: "2" }) },
    ]);
    // Assert the CONTENT, not the count: `slice(-2)` also yields length 2
    // while dropping the very id that was witnessed twice.
    expect(body._vc_agent_outbound_ids.map((row) => row.message_id).sort())
      .toEqual(["2", MESSAGE].sort());
  });

  it("refuses on the same ruler the store uses, so the two cannot disagree", () => {
    const bad = identity({ channel_id: "a\u0000b" });
    expect(outboundIdentityKey(bad)).toBe("");
    expect(outboundIdWireProjection([{ identity: bad }])).toEqual({});
  });

  it("never puts message content on the wire", () => {
    const body = outboundIdWireProjection([
      { identity: identity(), content: "secret", observed_at: "2026-08-20T00:00:00.000Z" },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});

describe("pending set (fast path)", () => {
  const entry = (over = {}) => ({
    identity: identity(over), observed_at: "2026-08-20T00:00:00.000Z",
  });

  it("a re-witnessed id is a no-op, never an error and never a second row", () => {
    const state = new Map();
    expect(rememberPendingOutboundId(state, "c", entry(), 1000).added).toBe(true);
    expect(rememberPendingOutboundId(state, "c", entry(), 1001).added).toBe(false);
    expect(pendingOutboundIdsForConversation(state, "c")).toHaveLength(1);
  });

  it("REGRESSION: reading the snapshot does NOT consume it (codex P1-4)", () => {
    // If reading consumed, an id classified onto the fast path and then lost to
    // a failed ingest would vanish with nothing recording the loss. Duplicates
    // are the safe direction; exactly-one-path classification is the unsafe one.
    const state = new Map();
    rememberPendingOutboundId(state, "c", entry(), 1000);
    expect(pendingOutboundIdsForConversation(state, "c")).toHaveLength(1);
    expect(pendingOutboundIdsForConversation(state, "c")).toHaveLength(1);
    expect(pendingOutboundIdsForConversation(state, "c")).toHaveLength(1);
  });

  it("only an explicit acknowledgement drops an entry", () => {
    const state = new Map();
    rememberPendingOutboundId(state, "c", entry(), 1000);
    expect(forgetPendingOutboundIds(state, "c", [outboundIdentityKey(identity())])).toBe(1);
    expect(pendingOutboundIdsForConversation(state, "c")).toHaveLength(0);
  });

  it("bounds per conversation and across conversations, and COUNTS every eviction", () => {
    const state = new Map();
    let evicted = 0;
    for (let i = 0; i < 5; i += 1) {
      evicted += rememberPendingOutboundId(
        state, "c", entry({ message_id: String(i) }), 1000,
        { maxPerConversation: 2, maxConversations: 10 },
      ).evicted;
    }
    expect(pendingOutboundIdsForConversation(state, "c")).toHaveLength(2);
    expect(evicted).toBe(3);

    const wide = new Map();
    let wideEvicted = 0;
    for (let i = 0; i < 4; i += 1) {
      wideEvicted += rememberPendingOutboundId(
        wide, `conv-${i}`, entry(), 1000, { maxConversations: 2 },
      ).evicted;
    }
    expect(wide.size).toBe(2);
    expect(wideEvicted).toBe(2);
  });

  it("expires by TTL and reports how many it expired", () => {
    const state = new Map();
    rememberPendingOutboundId(state, "c", entry(), 1000);
    expect(prunePendingOutboundIds(state, 1000 + 60_000, 30_000)).toBe(1);
    expect(state.size).toBe(0);
    expect(prunePendingOutboundIds(state, 2_000_000, 30_000)).toBe(0);
  });
});

describe("delta queue is non-blocking (spec 5.3, codex P0-1)", () => {
  const record = (over) => ({
    key: "k", conv_id: "sk:conv", enqueued_at: "2026-08-20T00:00:00.000Z", ...over,
  });

  it("PIN: records for the SAME conversation are independent -- no FIFO head", () => {
    // This is the property that forced a separate queue. The completion outbox
    // selects one head per conv_id and only unlinks on success, so a blocked id
    // follow-up would hold every later record for that conversation -- and
    // those records carry real users' disclosures. If a refactor ever
    // reintroduces head selection here, this test fails.
    const now = 10_000;
    const records = [
      record({ key: "a", next_attempt_at: new Date(now + 60_000).toISOString() }),
      record({ key: "b" }),
      record({ key: "c" }),
    ];
    const due = outboundIdDueRecords(records, now);
    expect(due.map((r) => r.key)).toEqual(["b", "c"]);
    expect(due.every((r) => r.conv_id === "sk:conv")).toBe(true);
  });

  it("every due record is returned, not one per conversation", () => {
    const now = 10_000;
    const records = [record({ key: "a" }), record({ key: "b" }), record({ key: "c" })];
    expect(outboundIdDueRecords(records, now)).toHaveLength(3);
  });

  it("REGRESSION: fewest attempts first, so a slow cohort cannot starve the rest", () => {
    // Records are attempted oldest-first up to a per-pass limit. With strict
    // age ordering, a cohort of failing records whose short backoffs expire
    // during the pass gets re-selected every pass, and records beyond the limit
    // are never attempted at all. That is starvation without a formal head.
    const ordered = outboundIdQueueOrder([
      { key: "old-failing", attempts: 7, enqueued_at: "2026-08-20T00:00:00.000Z" },
      { key: "new-fresh", enqueued_at: "2026-08-20T09:00:00.000Z" },
      { key: "old-fresh", enqueued_at: "2026-08-20T01:00:00.000Z" },
      { key: "old-retried-once", attempts: 1, enqueued_at: "2026-08-20T00:30:00.000Z" },
    ]);
    expect(ordered.map((r) => r.key))
      .toEqual(["old-fresh", "new-fresh", "old-retried-once", "old-failing"]);
  });

  it("orders deterministically and does not mutate its input", () => {
    const input = [
      { key: "b", enqueued_at: "2026-08-20T00:00:00.000Z" },
      { key: "a", enqueued_at: "2026-08-20T00:00:00.000Z" },
    ];
    expect(outboundIdQueueOrder(input).map((r) => r.key)).toEqual(["a", "b"]);
    expect(input.map((r) => r.key)).toEqual(["b", "a"]);
    expect(outboundIdQueueOrder(undefined)).toEqual([]);
  });

  it("a record with no next_attempt_at is due immediately", () => {
    expect(outboundIdDueRecords([record({ key: "a" })], 0)).toHaveLength(1);
  });
});

describe("queue bounds report their N (leg 4)", () => {
  const at = (ms) => new Date(ms).toISOString();

  it("drops aged records and counts them", () => {
    const now = 1_000_000;
    const removed = [];
    const out = enforceOutboundIdQueueBounds(
      [
        { key: "old", enqueued_at: at(now - 60_000) },
        { key: "new", enqueued_at: at(now - 1_000) },
      ],
      now, (r) => removed.push(r.key), null, { maxAgeMs: 30_000, maxRecords: 100 },
    );
    expect(out.droppedAged).toBe(1);
    expect(out.droppedOverflow).toBe(0);
    expect(out.live.map((r) => r.key)).toEqual(["new"]);
    expect(removed).toEqual(["old"]);
  });

  it("drops the OLDEST on overflow and counts them", () => {
    const now = 1_000;
    const removed = [];
    const records = [1, 2, 3, 4].map((i) => ({ key: `k${i}`, enqueued_at: at(now) }));
    const out = enforceOutboundIdQueueBounds(
      records, now, (r) => removed.push(r.key), null,
      { maxAgeMs: 1_000_000, maxRecords: 2 },
    );
    expect(out.droppedOverflow).toBe(2);
    expect(removed).toEqual(["k1", "k2"]);
    expect(out.live.map((r) => r.key)).toEqual(["k3", "k4"]);
  });

  it("logs both counts and the limits they were measured against", () => {
    const lines = [];
    enforceOutboundIdQueueBounds(
      [{ key: "a", enqueued_at: at(0) }], 1_000_000,
      () => {}, { warn: (line) => lines.push(line) },
      { maxAgeMs: 1, maxRecords: 10 },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("dropped_aged=1");
    expect(lines[0]).toContain("dropped_overflow=0");
    expect(lines[0]).toContain("remaining=0");
    expect(lines[0]).toContain("max_age_ms=1");
    expect(lines[0]).toContain("UNKNOWN");
  });

  it("REGRESSION: an epoch-0 timestamp ages normally instead of reading as fresh", () => {
    // `Date.parse(x) || now` maps a valid epoch-0 onto "just enqueued", so a
    // record stamped 1970 would never age out.
    const removed = [];
    const out = enforceOutboundIdQueueBounds(
      [{ key: "epoch", enqueued_at: at(0) }], 1_000_000,
      (r) => removed.push(r.key), null, { maxAgeMs: 30_000, maxRecords: 100 },
    );
    expect(out.droppedAged).toBe(1);
    expect(removed).toEqual(["epoch"]);
  });

  it("REGRESSION: a far-future timestamp is DROPPED, not silently immortal", () => {
    // Math.max(0, now - parsed) looked like a clamp but persisted nothing, so
    // age read 0 on EVERY scan until the wall clock caught up. Scanning
    // repeatedly is the part that makes this test discriminate: a single call
    // passes against the immortal implementation too.
    for (const nowMs of [1_000, 500_000, 1_500_000]) {
      const removed = [];
      const out = enforceOutboundIdQueueBounds(
        [{ key: "future", enqueued_at: at(2_000_000) }], nowMs,
        (r) => removed.push(r.key), null, { maxAgeMs: 30_000, maxRecords: 100 },
      );
      expect(out.droppedAged).toBe(1);
      expect(out.live).toEqual([]);
      expect(removed).toEqual(["future"]);
    }
  });

  it("tolerates ordinary clock skew rather than dropping on a few seconds", () => {
    const removed = [];
    const out = enforceOutboundIdQueueBounds(
      [{ key: "skewed", enqueued_at: at(1_005_000) }], 1_000_000,
      (r) => removed.push(r.key), null, { maxAgeMs: 30_000, maxRecords: 100 },
    );
    expect(out.droppedAged).toBe(0);
    expect(removed).toEqual([]);
  });

  it("drops a record whose timestamp cannot be parsed at all", () => {
    // Unparseable must not mean "immortal": a record that outlives its own
    // conversation can attach an identity claim to a successor.
    for (const enqueued_at of ["", "not-a-date", undefined, null, 12345]) {
      const removed = [];
      const out = enforceOutboundIdQueueBounds(
        [{ key: "bad", enqueued_at }], 1_000,
        (r) => removed.push(r.key), null, { maxAgeMs: 30_000, maxRecords: 100 },
      );
      expect(out.droppedAged).toBe(1);
      expect(removed).toEqual(["bad"]);
    }
  });

  it("stays silent when nothing was dropped, so a warning always means loss", () => {
    const lines = [];
    enforceOutboundIdQueueBounds(
      [{ key: "a", enqueued_at: at(1_000) }], 1_000,
      () => {}, { warn: (line) => lines.push(line) },
    );
    expect(lines).toHaveLength(0);
  });
});

describe("the wire key is the receiver's reserved key", () => {
  it("REGRESSION: sends _vc_agent_outbound_ids, never a bare name", () => {
    // The receiver defines its wire field AS the engine's reserved key, so a
    // sender's field and a reader's lookup cannot drift apart. A bare
    // `agent_outbound_ids` is read by nothing and the ledger would stay empty
    // WITH NO ERROR ANYWHERE.
    //
    // This name flip-flopped once, in both directions, and cost a wrong commit
    // on each side. The lesson is in the assertion: verify against the deployed
    // receiver, not against either side's description of itself.
    const body = outboundIdWireProjection(
      [{ identity: identity(), observed_at: "2026-08-20T00:00:00.000Z" }], "vast",
    );
    expect(Object.keys(body)).toEqual(["_vc_agent_outbound_ids"]);
    expect(body).not.toHaveProperty("agent_outbound_ids");
  });
});

describe("the exact-completion fingerprint ignores outbound ids", () => {
  const KEY = "_vc_agent_outbound_ids";
  const base = {
    assistant_message: "a reply",
    user_message: "a question",
    exact_source_admission: { version: 2, conversation_generation: 0 },
  };
  const ids = (n) => Array.from({ length: n }, (_, i) => ({
    platform: "discord", account_id: "vast",
    channel_id: CHANNEL, message_id: `15290000000000000${10 + i}`,
    observed_at: "2026-08-20T00:00:00.000Z",
  }));

  it("REGRESSION: present, absent and CHANGED all fingerprint identically", () => {
    // queueExactCompletion dead-letters a re-queue whose fingerprint differs,
    // and its caller then returns without queuing the completion AT ALL. Since
    // identities are witnessed asynchronously, the same source message can be
    // queued twice with different sets -- so covering them would convert an
    // ordinary retry into a LOST TURN carrying a real person's message.
    const absent = completionOutboxFingerprint("sk:c", base);
    const present = completionOutboxFingerprint("sk:c", { ...base, [KEY]: ids(1) });
    const changed = completionOutboxFingerprint("sk:c", { ...base, [KEY]: ids(3) });
    const emptied = completionOutboxFingerprint("sk:c", { ...base, [KEY]: [] });
    expect(present).toBe(absent);
    expect(changed).toBe(absent);
    expect(emptied).toBe(absent);
  });

  it("POSITIVE CONTROL: it still covers everything else", () => {
    // Without this, a fingerprint that ignored the whole payload would pass
    // the test above.
    const baseline = completionOutboxFingerprint("sk:c", base);
    expect(completionOutboxFingerprint("sk:c", {
      ...base, assistant_message: "a different reply",
    })).not.toBe(baseline);
    expect(completionOutboxFingerprint("sk:c", {
      ...base, user_message: "a different question",
    })).not.toBe(baseline);
    expect(completionOutboxFingerprint("sk:other", base)).not.toBe(baseline);
    expect(completionOutboxFingerprint("sk:c", {
      ...base, exact_source_admission: { version: 2, conversation_generation: 1 },
    })).not.toBe(baseline);
  });

  it("handles a non-object payload without throwing", () => {
    for (const payload of [null, undefined, "x", 7]) {
      expect(completionOutboxFingerprint("sk:c", payload)).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe("late-path response classification", () => {
  it("treats accepted and duplicate as success -- a duplicate is a no-op, not a failure", () => {
    for (const body of [
      { accepted: 1 }, { duplicate: 1 }, { accepted: 0, duplicate: 1 },
      { accepted: 1, duplicate: 0, malformed: 0 },
    ]) {
      expect(classifyOutboundIdResponse(body).ok).toBe(true);
    }
  });

  it("names every permanent decline the engine can return", () => {
    for (const reason of [
      // live reasons the receiver returns today
      "malformed_identity", "unresolvable_tenant_scope", "conversation_deleted",
      "ambiguous_alias_resolution", "fence_rejection",
      // distinct from fence_rejection on purpose: an unknown epoch start means
      // EVERY identity for that conversation declines forever, which needs a
      // different remedy than one stale record being correctly fenced
      "epoch_start_unknown",
      // names used earlier and possibly again; superset by design
      "malformed", "not_canonical", "unknown_conversation", "predates_epoch",
    ]) {
      const verdict = classifyOutboundIdResponse({ [reason]: 1 });
      expect(verdict).toMatchObject({ ok: false, reason, permanent: true });
      expect(outboundIdFailureIsPermanent(new Error("x"), verdict)).toBe(true);
    }
  });

  it("the store-unavailable class is the ONLY retryable decline", () => {
    for (const reason of ["store_unavailable", "write_failed"]) {
      const verdict = classifyOutboundIdResponse({ [reason]: 1 });
      expect(verdict).toMatchObject({ ok: false, reason, permanent: false });
      expect(outboundIdFailureIsPermanent(new Error("x"), verdict)).toBe(false);
    }
  });

  it("REGRESSION: a response with no recognisable outcome is NOT success", () => {
    // The shape this replaces checked `result?.status`, which is absent from a
    // counts-keyed body -- so a DECLINED record was unlinked as delivered and
    // the identity vanished with a success in the log.
    for (const body of [
      {}, { accepted: 0 }, { unrelated: 3 }, { accepted: "1" },
      null, undefined, "ok", 7,
    ]) {
      const verdict = classifyOutboundIdResponse(body);
      expect(verdict.ok).toBe(false);
      // Unknown is retried, never discarded.
      expect(outboundIdFailureIsPermanent(new Error("x"), verdict)).toBe(false);
    }
  });

  it("still understands a receiver that has not moved to counts yet", () => {
    expect(classifyOutboundIdResponse({ status: "accepted" }).ok).toBe(true);
    expect(classifyOutboundIdResponse({ status: "idempotent" }).ok).toBe(true);
    const declined = classifyOutboundIdResponse({
      status: "declined", reason: "predates_epoch",
    });
    expect(declined).toMatchObject({ ok: false, permanent: true });
  });

  it("retries an UNRECOGNISED reason rather than discarding the record", () => {
    const verdict = classifyOutboundIdResponse({
      status: "declined", reason: "some_future_reason",
    });
    expect(verdict.ok).toBe(false);
    expect(outboundIdFailureIsPermanent(new Error("x"), verdict)).toBe(false);
  });

  it("honours an explicit permanent flag for a reason it has never heard of", () => {
    // This is the drift case: the engine adds a sixth decline reason and marks
    // it permanent. Falling back to the local reason set would retry it
    // forever. The receiver's own verdict wins over this side's stale table.
    expect(outboundIdFailureIsPermanent(
      new Error("x"), { reason: "a_reason_added_after_this_shipped", permanent: true },
    )).toBe(true);
    // And the converse: a reason this side thinks is permanent, which the
    // receiver says is retryable, is retried.
    expect(outboundIdFailureIsPermanent(
      new Error("x"), { reason: "predates_epoch", permanent: false },
    )).toBe(false);
  });

  it("a bare reason with no verdict still classifies, and unknown still retries", () => {
    // outboundIdFailureIsPermanent is exported and can be handed a verdict that
    // carries only a reason. That branch is defence, so it gets a test rather
    // than being left to rot untested.
    expect(outboundIdFailureIsPermanent(new Error("x"), { reason: "predates_epoch" }))
      .toBe(true);
    expect(outboundIdFailureIsPermanent(new Error("x"), { reason: "write_failed" }))
      .toBe(false);
    expect(outboundIdFailureIsPermanent(new Error("x"), { reason: "invented_later" }))
      .toBe(false);
  });

  it("falls back to the HTTP status only when there is no verdict at all", () => {
    for (const status of [400, 404, 405, 409, 410, 413, 422, 501]) {
      expect(outboundIdFailureIsPermanent(new Error(`VC API ${status}: nope`)))
        .toBe(true);
    }
  });

  it("treats only NAMED rejections as permanent", () => {
    for (const status of [400, 404, 405, 409, 410, 413, 422, 501]) {
      expect(outboundIdFailureIsPermanent(new Error(`VC API ${status}: nope`))).toBe(true);
    }
  });

  it("retries everything else, including a status it could not read", () => {
    for (const status of [401, 403, 408, 429, 500, 502, 503, 504]) {
      expect(outboundIdFailureIsPermanent(new Error(`VC API ${status}: later`))).toBe(false);
    }
    // An unreadable failure is UNKNOWN. Unknown is retried, never discarded.
    for (const error of [
      new Error("fetch failed"), new Error("The operation was aborted"),
      new Error("VC API abc: weird"), undefined, null, "",
    ]) {
      expect(outboundIdFailureIsPermanent(error)).toBe(false);
    }
  });
});

describe("the instrument states its own limitations (legs 3 and 4)", () => {
  const context = { mode: "observe", convIdentity: "stable", latePath: "" };

  it("an unfired hook reports NO DATA and refuses to read as health", () => {
    const line = renderOutboundIdReport(newOutboundIdStats(), context);
    expect(line).toContain("NO DATA");
    expect(line).toContain("events=0");
    expect(line).toContain("has not fired");
    expect(line.toLowerCase()).not.toContain("healthy");
    expect(line.toLowerCase()).not.toContain("clean");
  });

  it("a fired hook still prints capture_rate=UNKNOWN against real deliveries", () => {
    const stats = newOutboundIdStats();
    stats.events = 12;
    stats.witnessed = 9;
    noteOutboundIdRefusal(stats, "no_channel_ruler:telegram");
    noteOutboundIdRefusal(stats, "no_channel_ruler:telegram");
    const line = renderOutboundIdReport(stats, context);
    expect(line).toContain("events=12");
    expect(line).toContain("witnessed=9");
    expect(line).toContain("no_channel_ruler:telegram=2");
    expect(line).toContain("capture_rate=UNKNOWN");
    // The within-host denominator (sent_per_sending) does NOT make this a
    // capture rate: no per-delivery counter for Discord exists in the host.
    expect(line).toContain("no per-delivery ");
    expect(line).toContain("Discord");
  });

  it("reports sent_per_sending and capture_rate as DIFFERENT questions", () => {
    // Conflating them is the trap: one measures whether the post-delivery hook
    // fired for every outbound message the plugin saw; the other would measure
    // coverage of real platform deliveries, which nothing here can count.
    const stats = newOutboundIdStats();
    stats.events = 3;
    stats.sendingHookEvents = 4;
    const line = renderOutboundIdReport(stats, context);
    expect(line).toContain("sendingHook=4");
    expect(line).toContain("sent_per_sending=0.75");
    expect(line).toContain("capture_rate=UNKNOWN");
    expect(line).toContain("TWO DIFFERENT RATIOS");
    expect(line).toContain("not independent");
    expect(line).toContain("only in the Telegram adapter");
  });

  it("says NO_DATA rather than dividing by zero", () => {
    const stats = newOutboundIdStats();
    stats.events = 2;
    const line = renderOutboundIdReport(stats, context);
    expect(line).toContain("sent_per_sending=NO_DATA");
    expect(line).not.toContain("sent_per_sending=Infinity");
    expect(line).not.toContain("sent_per_sending=NaN");
  });

  it("publishes the multi-chunk hole as a LOWER BOUND with its threshold", () => {
    // The N-1 non-tail ids of a split reply are never offered to any hook, so
    // no honest count of them exists. A bound with its instrument stated is
    // publishable; a number that cannot be defended is not.
    const stats = newOutboundIdStats();
    stats.events = 4;
    stats.chunkedLowerBound = 2;
    const line = renderOutboundIdReport(stats, context);
    expect(line).toContain("multiChunkPayloads>=2");
    expect(line).toContain("LOWER BOUND, not a count");
    expect(line).toContain("PROXY");
    expect(line).toContain("DOES NOT CLOSE THE DEFECT FOR MULTI-CHUNK REPLIES");
    expect(line).toContain("Never fold this number into a success rate");
  });

  it("breaks events down by agent scope, so a delivering-but-not-ingesting scope is nameable", () => {
    const stats = newOutboundIdStats();
    stats.events = 3;
    stats.byAgentScope.set("vast", 2);
    stats.byAgentScope.set("bastkid-dedicated", 1);
    const line = renderOutboundIdReport(stats, context);
    expect(line).toContain("byAgentScope[vast=2 bastkid-dedicated=1]");
  });

  it("says none rather than an empty bracket when no scope was seen", () => {
    const stats = newOutboundIdStats();
    stats.events = 1;
    expect(renderOutboundIdReport(stats, context)).toContain("byAgentScope[none]");
  });

  it("names all three populations it is structurally blind to", () => {
    const stats = newOutboundIdStats();
    stats.events = 1;
    const line = renderOutboundIdReport(stats, context);
    expect(line).toContain("multi-chunk");
    expect(line).toContain("Telegram");
    expect(line).toContain('convIdentity="session"');
    expect(line).toContain("UNCOVERED");
  });

  it("declines to report ordering rather than correlating on an ambiguous key", () => {
    const stats = newOutboundIdStats();
    stats.events = 3;
    const line = renderOutboundIdReport(stats, context);
    expect(line).toContain("Ordering against ingest is likewise");
    expect(line).toContain("NOT reported");
  });

  it("carries every counter a reader needs to locate loss", () => {
    const stats = newOutboundIdStats();
    stats.events = 5;
    const line = renderOutboundIdReport(stats, context);
    for (const counter of [
      "success=", "withMessageId=", "withSessionKey=", "withRunId=",
      "witnessed=", "duplicates=", "carried=", "queued=", "queuedDuplicate=",
      "queueRefused=", "unbackedFast=", "evictedPending=",
    ]) expect(line).toContain(counter);
  });
});

describe("queue inventory surfaces orphaned scopes (codex P1-6)", () => {
  it("names orphaned directories that no configured key can ever drain", () => {
    const line = renderOutboundIdInventory({
      configuredCount: 1,
      scopes: [
        {
          deployment_id: "a".repeat(64), credential_matched: true,
          drainable: true, records: 2, oldest_age_ms: 100,
          age_unknown_records: 0, scan_error: "",
        },
        {
          deployment_id: "b".repeat(64), credential_matched: false,
          drainable: false, records: 7, oldest_age_ms: 90_000,
          age_unknown_records: 0, scan_error: "",
        },
      ],
    });
    expect(line).toContain("orphaned_scopes=1");
    expect(line).toContain("orphaned_records=7");
    expect(line).toContain("drainable_records=2");
    expect(line).toContain("oldest_orphan_age_ms=90000");
    expect(line).toContain("key rotation");
    expect(line).toContain("do not assume");
  });

  it("does not print an orphan warning when there are none", () => {
    const line = renderOutboundIdInventory({
      configuredCount: 1,
      scopes: [{
        deployment_id: "a".repeat(64), credential_matched: true, drainable: true,
        records: 0, oldest_age_ms: 0, age_unknown_records: 0, scan_error: "",
      }],
    });
    expect(line).toContain("orphaned_scopes=0");
    expect(line).not.toContain("ORPHANED:");
  });

  it("distinguishes HELD from ORPHANED: a matched credential with delivery disarmed", () => {
    // Collapsing these into one "not drainable" bucket told an operator their
    // records were unreachable when they are merely stored and undelivered.
    const line = renderOutboundIdInventory({
      configuredCount: 1,
      scopes: [{
        deployment_id: "a".repeat(64), credential_matched: true, drainable: false,
        records: 4, oldest_age_ms: 10, age_unknown_records: 0, scan_error: "",
      }],
    });
    expect(line).toContain("held_records=4");
    expect(line).toContain("orphaned_scopes=0");
    expect(line).toContain("Not lost, and not delivered either");
  });

  it("reports an unreadable scope as unknown rather than as zero records", () => {
    const line = renderOutboundIdInventory({
      configuredCount: 1,
      scopes: [{
        deployment_id: "a".repeat(64), credential_matched: true, drainable: false,
        records: 0, oldest_age_ms: 0, age_unknown_records: 0, scan_error: "EACCES",
      }],
    });
    expect(line).toContain("scan_failures=1");
    expect(line).toContain("unknown rather than zero");
  });

  it("a failed root scan says so instead of rendering an empty queue", () => {
    const line = renderOutboundIdInventory({
      configuredCount: 1, scopes: [], rootScanError: "EACCES",
    });
    expect(line).toContain("SCAN FAILED");
    expect(line).toContain("not an empty queue");
    expect(line).toContain("not health");
  });

  it("an empty disk reads as 'nothing was ever queued', not as health", () => {
    const line = renderOutboundIdInventory({ configuredCount: 2, scopes: [] });
    expect(line).toContain("NO DIRECTORIES ON DISK");
    expect(line).toContain("NOT that delivery is healthy");
  });
});
