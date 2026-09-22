# Spec: Outbound message-id capture for the Virtual Context OpenClaw plugin

**Status:** v5 — Phase A is LIVE in production (`carry` since 15:53 UTC 2026-08-20) and
**FROZEN**: production deploys, gateway restarts and config changes are stopped by the user's
instruction as of 2026-08-20. Prod runs `6f9c4e2`, tree verified equal to the commit, nothing
mid-flight and nothing built-and-waiting. **Read §1's correction before citing this document's
motivation.** The
cross-stack contract is ACCEPTED and both halves are built. See §9.2 for measured results and §10.1
for the one remaining blocker. Prior history: v3 — v2 was reviewed and came back **NOT CLEAR: 3 P0, 5 P1, 2 P2**. This revision folds
all ten. Three of them were *real defects in v2's design*, not polish, and two of those were found
only because the review checked v2's claims against `index.js` instead of against v2's prose:

| # | v2 said | Reality | Now |
|---|---|---|---|
| P0-3 | The binding gate is `deriveConvIdentity(sessionKey, null, groupIndex)` and `convIdentity:"session"` deployments "capture nothing" | **False.** `deriveConvIdentity` is a pure derivation, not a policy — it returns `sk:<key>` for a Discord key *regardless of configured mode*. In session mode, base turns would ingest under a session UUID while ids landed on `sk:<key>`: **a different conversation.** | §4.1, gate starts `if (!stableMode) drop`. Shipped + regression test. |
| P0-2 | I-2 names the tuple | It never said how to *build* it. `ctx.channelId` is the transport name (`"discord"`), not the channel. | §3 I-2a canonicalization clause. Shipped + negative-control test. |
| P1-4 | ids ride ingest, "otherwise" the queue | Exactly-one-path classification loses an id when the ingest fails. | §4.2 — durable first, fast path is a permitted duplicate. |

Everything v1 established is still carried forward. v1 itself is gone and should not be looked for.
**Owner:** openclaw@vc (plugin half). Engine half is core@vc's. §3 is a JOINT contract, not a plugin spec.
**Plugin:** `openclaw-plugin-virtual-context` 5.7.0. Production copy on Linode is source of truth.
**Gateway measured against:** OpenClaw 2026.7.1-beta.2 (`a580a7f`), Linode `45.33.74.201`.

---

## 0. Revision history

The v2-vs-v3 diff is the table in the status block above. For the record, what v1 got wrong (v1 is
gone — it lived in `/tmp` and did not survive a machine restart):

| v1 said | Reality | Where proved |
|---|---|---|
| Correlate `message_sent` to the turn by `runId` | **`runId` is not populated on the outbound delivery path.** The whole correlation mechanism does not exist. | §2.2 |
| Reuse the completion outbox for the late case | The completion outbox enforces one FIFO head per conversation and its reader quarantines records without a prepare generation token. Both are fatal here. | §5.1 |
| §5 states a safety principle | A principle is not a rule. §5 is now five numbered invariants with a monotonicity proof obligation. | §3 |
| Verification via `modelCallCapture` | `modelCallCapture` records `llm_input` / `llm_output` only. It has never seen a `vcPost` body. | §7 |
| Scope: plugin only | The safety property spans plugin and engine. A property spanning two systems cannot be proved inside one system's spec. | §3 |

---

## 1. Problem

> ### ⚠️ CORRECTION — this is NOT the fix for the incident that started it
>
> This work was commissioned after a Discord agent stated a false biographical fact about a member.
> **It has since been established that this defect did not cause that claim.** The member's own
> cessation record existed, correctly attributed, for **15.7 days — and was never retrieved into any
> prompt.** The demonstrated incident was a **retrieval** failure, and the record behind it was
> **assistant-lane and anonymous**, not subject-lane.
>
> **The defect described below is real, larger, and independently worth fixing** — 97% of the
> subject lane is affected (§9.5). But **nobody should describe this spec, the fence, or the outbound
> ledger as the fix for that member's claim**, including its author, who was doing exactly that
> until corrected. The original framing is preserved here rather than quietly rewritten, because a
> spec that silently retcons its own motivation teaches nothing.

The defect this actually addresses: the memory layer stores the assistant's own words under a role
that asserts a HUMAN said them. When a member quote-replies the bot, the anti-duplicate guard tries
to identify the quoted target and cannot — **the bot's own outbound message ids are not stored
anywhere, in any system.** With no way to recognise its own text, the quoted body is re-extracted
through a subject lane and stamped as that person's claim. The agent can later report it back as
fact about them.

The mechanism is exact and named: `compaction_pipeline.py:2503-2517` sets
`target_present = len(target_candidates) == 1`; when False, `:2519` files
`FactLane(role=AUTHOR_ROLE_SUBJECT, ...)`. **The success criterion for this whole effort is whether
that count becomes 1.**

The guard is not broken. It is being asked a question about identity with no identity data to answer
from. The complete fix requires capturing the bot's outbound message id at the moment of delivery.
That capture is only possible inside OpenClaw, and is therefore this plugin's half.

### 1.1 Non-goals

- This spec does not change how the guard suppresses. That is engine-side (core@vc).
- This spec does not attempt to reconstruct historical outbound ids. There is no source for them.
  Everything before the ship date is permanently unknown, and §3 I-1 makes that safe rather than silent.
- This spec does not touch the attribution/actor-card path, the completion outbox, or ingest content.

---

## 2. Measured facts about the outbound path

Everything in this section is read from the deployed bundle on the production host. It is **static
analysis of the shipped code, not runtime measurement.** §6 Phase A is the runtime confirmation, and
if Phase A contradicts anything here, this section is wrong and gets rewritten, loudly.

### 2.1 `message_sent` exists, is fire-and-forget, and carries an id

`dist/hook-types-DTDA8FLm.d.ts:268-280`:

```
type PluginHookMessageSentEvent = {
  to: string; content: string; success: boolean;
  messageId?: string; sessionKey?: string; runId?: string;
  trace?: ...; traceId?: string; spanId?: string; parentSpanId?: string;
  error?: string;
};
```

Fire-and-forget is literal, not inferred. `dist/hook-runner-global-CCFujk2O.js:783-785` implements
`runMessageSent` as `runVoidHook`, and every call site wraps it in `fireAndForgetHook(...)`
(`dist/deliver-DeFdoNqL.js:727`, `dist/delivery-0pv6pPN1.js:649`).

**Consequence carried from v1, restated because it is the load-bearing one:** *"available"* and
*"available synchronously at ingest"* are different claims, and only the first is proven. The
plugin must be correct when the id arrives after the ingest has already completed.

### 2.2 CORRECTION — `runId` is NOT plumbed through the outbound path

> **SCOPE GUARD, added 2026-08-21 after this section was generalised into a false claim.**
> **Everything below is about `event.runId` on the OUTBOUND hooks and nothing else.** The turn
> path's `ctx.runId` at `agent_end` is a **different field on a different object** and is
> **populated** — measured 11 of 11, including a group turn (§10.3.0).
>
> **The quoted SDK text below contains the exact warning against the inference that was made from
> it** — *"should not rely on `runId` to correlate against `agent_end`"* — which distinguishes the
> two paths explicitly. **The source was right, the reading was not.** Do not cite this section as
> evidence about the turn path.


The SDK documents this against the `runId` field itself, `dist/hook-types-DTDA8FLm.d.ts:166-183`:

> It is **not yet** plumbed through the outbound delivery path, so plugins observing
> `message_sending` / `message_sent` should not rely on `runId` to correlate against `agent_end`;
> use `sessionKey` for outbound→inbound correlation today (with the caveat that it cannot
> disambiguate concurrent turns in the same session).

Confirmed at the emit site rather than taken on the doc's word. `dist/deliver-DeFdoNqL.js:709-737`,
`createMessageSentEmitter`:

```js
const canonical = buildCanonicalSentMessageHookContext({
  to: params.to, content: event.content, success: event.success, error: event.error,
  channelId: params.channel, accountId: params.accountId ?? void 0,
  conversationId: params.to,
  sessionKey: params.sessionKeyForInternalHooks,     // present
  messageId: event.messageId,                        // present
  isGroup: params.mirrorIsGroup, groupId: params.mirrorGroupId,
});                                                  // runId: never passed
```

`dist/message-hook-mappers-Bq-Pvuvu.js:266-278` then spreads `...canonical.runId ? {runId} : {}`, so
an unset `runId` is simply absent from the event rather than present-and-undefined. Identical
conditional for the ctx object at `:97-115`.

**v1's design was `subscribe to message_sent, correlate by runId`. That design cannot be built.**

### 2.3 What IS available, per channel

`sessionKey` on the generic path comes from `dist/deliver-DeFdoNqL.js:1074`:
`params.mirror?.sessionKey ?? params.session?.key`.

Telegram does not use the generic emitter. `dist/delivery-0pv6pPN1.js:627-640`
`buildTelegramSentHookContext` passes neither `runId` **nor `sessionKey`**.

| Field | Generic path (Discord et al.) | Telegram |
|---|---|---|
| `messageId` | yes | yes |
| `sessionKey` | yes | **no** |
| `runId` | **no** | **no** |
| `channelId` / `accountId` / `conversationId` (ctx) | yes | yes |
| `success`, `content` | yes | yes |

The incident channel is Discord, which is the generic path.

### 2.4 Only the LAST chunk's id is emitted (codex P1, confirmed)

`dist/deliver-DeFdoNqL.js:1249-1275`, the multi-chunk text branch:

```js
const deliveredResults = results.slice(beforeCount);
...
const messageId = deliveredResults.at(-1)?.messageId;   // <- last chunk only
...
emitMessageSent({ success: deliveredResults.length > 0, content: ..., messageId });
```

A reply chunked into N platform messages emits **one** `message_sent` carrying the **tail** id. The
other N-1 ids are never offered to any hook. `emitMessageSent` fires once per *payload*, so a turn
with multiple payloads yields multiple events — each still tail-only for its own payload.

**Completeness of the id set is therefore structurally impossible on this gateway.** This is not a
tuning problem and no amount of care on my side fixes it. It is the direct justification for I-3.

### 2.5 History-buffer measurement (carried from v1)

108 captures: 105 at `len=1`, 3 at `len=0`, max 1. Stated here only so it is not re-measured;
it does not bear on this design.

---

## 3. THE CROSS-STACK ACCEPTANCE CONTRACT (joint with core@vc)

> **STATUS: ACCEPTED by core@vc.** All five invariants accepted; one amendment
> to I-2, one consequence added to I-5, and three rulings folded below. This is
> no longer a strawman.

### 3.0 What the ids are actually for — the exact line

core@vc named it, and it makes the whole feature falsifiable rather than
plausible. `core/compaction_pipeline.py:2503-2517`: on a quote-reply the guard
looks for the quoted message among ingested transport rows by
`source_message_id == target_id`, plus audience and channel, and sets
`target_present = len(target_candidates) == 1`. When that is False, `:2519`
appends `FactLane(role=AUTHOR_ROLE_SUBJECT, ...)`.

The bot's own outbound ids are in no table, so **a quote-reply to the bot never
finds a candidate**, and the bot's own words are filed as a person's disclosure.

The store already exists: `canonical_message_sources`
(`storage/postgres.py:2060-2090`), PK
`(tenant_id, agent_scope_id, platform, account_id, message_id)` plus
`channel_id`, `guild_id`, `reply_target_message_id`, `observed_at`. **The I-2
tuple is a subset of a key that is already there.** This spec is not proposing a
store; it is feeding one.

The success criterion follows, and it is a single number: **does that
`len(target_candidates)` become 1.**



Codex's structural finding against v1 was that v1 scoped the engine out while making its safety
section load-bearing on engine behavior. **A safety property spanning two systems cannot be proved
inside one system's spec.** This section is therefore not a plugin spec. It is one contract, and
core@vc has veto over every line. Neither half ships until both halves accept the same list.

The property being protected, stated once, plainly:

> A real person's disclosure must never disappear because this feature guessed.

Every invariant below is downstream of that sentence.

### I-1 — MONOTONIC. Absence is never evidence.

> An exact witnessed identity is **positive evidence**.
> **Absence is unknown. An empty set is unknown. Non-membership in a partial set is unknown.**
> Timeout, retention expiry, restart, delivery failure, a channel that never emits, a version of
> this plugin that predates the feature — **all unknown.**
> **No "complete" bit may be inferred from silence, by either side.**

Neither side may introduce a `complete: true`, a `final: true`, or a count that could be read as a
denominator. If the engine ever wants completeness it must come from a source other than my silence,
and that source does not currently exist.

The reason this is invariant #1 and not a footnote: the failure it prevents is *invisible*. A
suppression that fires on an unknown deletes a member's disclosure and logs a success.

### I-2 — Exact match on a NAMESPACED, CANONICALIZED identity. Never a bare message id.

Suppression requires an exact match on the full tuple:

```
(platform, bot_account_id, channel_id, message_id)
```

A bare `message_id` is not an identity. Discord snowflakes are unique per platform, but this system
holds Telegram ids (small integers, colliding across chats), web ids, and future channels, in one
store. Matching on a bare id across namespaces is a false positive, and a false positive here is a
real person's disclosure vanishing.

#### I-2a — the tuple needs a CANONICALIZATION, or it silently never matches

Naming four fields is not enough, and v2's failure to say how to build them was a P0. Two traps,
both live in the code:

- **`ctx.channelId` is the transport name, not the channel.** It carries `"discord"`. The physical
  channel lives in `ctx.conversationId` as `channel:<snowflake>` and the *inbound* path already
  canonicalizes it through `trustedDiscordChannelId` into a bare snowflake, which is what
  `origin_channel_id` holds. **Both sides must use that same function.** A tuple built with a
  different ruler than the side comparing it can never match — and a never-matching set is
  indistinguishable from an absent one, i.e. a total silent failure that looks exactly like
  "no ids were captured yet."
- **`ctx.accountId` is an OpenClaw config alias, not the platform bot's immutable id.** Two
  deployments can both name an account `"default"`.

**RULED by core@vc: emit the alias.** The engine never *interprets* `account_id` — it stores the
string the inbound path supplied — so alias-versus-platform-id is only ever a checker/checked
agreement, and resolving a platform bot id on this side alone would **break** matching rather than
harden it. The reasoning that got here was right for the right reason: the checker and the checked
must use the same ruler.

**Amendment from core@vc: the engine's identity is FIVE components, not four.** `tenant_id` and
`agent_scope_id` lead the PK. Both are resolved from the request context on the receiving side, so
**the wire shape does not carry them** — but a record whose tenant or scope cannot be resolved is a
**permanent** rejection, not a retry. `channel_id` is matched as an equality alongside the PK,
exactly as the four-component tuple requires.

Every component is validated as an **exact primitive string** — non-empty, length-bounded, no
control characters, already-canonical (no value that a trim would change), platform lower-cased.
Anything else drops the metadata. The validator runs *at the point the identity becomes a key*,
not wherever someone remembered to call it, because a key function that trusts its caller is a key
function that can be made to collapse two identities into one.

### I-3 — The wire field is an ADDITIVE IDEMPOTENT SET. Never a replacing list.

Semantics on receipt: **union into what you already hold.** Re-sending a known id is a no-op, not an
error and not a duplicate row. Never "here is the full list for this conversation."

Forced by §2.4, which is a defect in the host, not caution on my part: the delivery path emits only
the tail chunk's id, so any list I send is provably partial. **If the engine treats the set as
complete it is wrong by construction, on turn one, forever.**

### I-4 — Fail open FOR THE METADATA ONLY. The turn is the product.

Malformed, missing, unparseable, over-long or rejected id metadata must **never** reject, delay, or
degrade the base ingest. The metadata is an enhancement; the turn is the product. This binds both
sides: I will never let an id failure cost a turn, and the engine must never reject a turn over one.

Note the asymmetry with I-1 and keep it straight: **fail open on the metadata, fail closed on
suppression.** Losing an id costs a repeat of a bug. Suppressing on an unknown costs a person's
words. They are not symmetric and must not be traded off against each other.

### I-5 — Isolated ordering and retry domain.

Delivery of ids runs in a queue whose ordering and retry domains are **distinct from the completion
outbox** (§5.1 for why this is fatal otherwise). Shared *helpers* are fine; shared *domains* are not.

The corollary is the part core@vc must build against: **ids can arrive after the turn they belong
to, out of order relative to each other and to turns, and more than once.** All three are normal
operation, not error conditions.

**Consequence added by core@vc, and it bounds what this feature can claim: a late id does NOT
retroactively repair an extraction that already ran.** The guard runs at extraction time, so an id
landing after a turn was extracted leaves the already-filed subject lane exactly where it is.
Repairing what is already filed is a separate derived-data rebuild, queued on their side and
sequenced **after** this ships.

This is less damaging than it first reads, and the reason is worth stating rather than assuming:
**the quote-reply that triggers the bad extraction happens on a LATER turn than the reply being
quoted.** The id must therefore arrive before turn *N+k*'s extraction, not before turn *N*'s — a
human-timescale gap, seconds to hours, not a race. The deferred path is sufficient for the ordinary
case and fails only when delivery is *still* failing k turns later. **Confirmation requested from
core@vc**; if the extraction that matters is the same turn's, the late path is close to useless and
the design changes.

### 3.1 Joint acceptance tests

One list, **three columns** — because v2 wrote them as end-state outcomes and the review's verdict
was blunt: *"the plugin suite can be green while the harmful suppression behavior is completely
untested."* That is true, and it is the failure mode this whole document exists to avoid, so the
split is now explicit. **Five of the ten are engine-only. My side cannot turn any of them green.**

| # | Case | Plugin conformance (mine, unit-testable) | Engine conformance (core@vc) | Cross-stack |
|---|---|---|---|---|
| A1 | Id witnessed, bot's own message later quote-replied | Tuple emitted with the canonical channel id | **Guard suppresses the re-extraction** | live probe |
| A2 | Id never arrives (hook silent, channel does not emit, older plugin) | Nothing emitted; refusal counted **by name** | **Degrades to exactly today's behavior, never to suppression** | live probe |
| A3 | Same id twice | Union no-op at the pending set and at the queue path | **No duplicate row, no error, no dead-letter** | — |
| A4 | Ids out of order and after their turn | Queue has no head; every due record attempted | **Both accepted; order carries no meaning** | live probe |
| A5 | Partial set present, a **NON-MEMBER** bot message quote-replied | *(structural only)* nothing emitted implies completeness | **MUST NOT suppress** — the I-1 test, and the one most likely to be got wrong | live probe |
| A6 | Malformed id metadata on an ingest | Metadata dropped, base ingest byte-identical | **Turn persists in full; no turn-level rejection** | live probe |
| A7 | Id lands for a conversation since merged/attached/deleted | Record carries only conv id + tuple | **Ruling required — see below** | — |
| A8 | Same bare id under a different platform/account/channel | Keys differ in every component | **No cross-namespace match** | — |
| A9 | Multi-chunk reply (N messages, tail id only) | Set holds the tail id; a **lower bound** on split payloads is published | **The other N-1 are unknown, not absent** — A5 then governs them | — |
| A10 | Plugin restarts with ids queued | Records deliver or are dropped; never re-scoped | *(n/a)* | live probe |

**Rules for this table, so it cannot be quietly satisfied:**
- A green plugin column is **not** evidence for the engine column. Reporting one as the other is the
  failure this split exists to prevent.
- Every cross-stack case runs against a **disposable session**, with read-only store evidence, and
  each needs a **negative-control mutation that makes it fail.** A test that has never failed has
  not been shown to discriminate.
- **A7 is RULED (§3.2) and is now a real row.** All three outcomes are permanent; nothing retries.

**Two coverage limits recorded as limits rather than passes, at core@vc's insistence, because a
green suite that hides them is the exact failure this contract exists to prevent:**

- **A9 is a real hole, not a rounding error. This feature does not close the defect for multi-chunk
  replies.** Tail-id-only means an N-message reply leaves N-1 bot messages unwitnessed, A5 governs
  them, and they keep producing subject lanes. No honest *count* of them exists — those ids are
  never offered to any hook. What the instrument publishes is a **lower bound**: payloads whose
  content exceeded a single platform message, printed with the threshold used, labelled as a proxy,
  and **never folded into a success rate.**
- **Telegram is uncovered in v1** — same treatment: printed as *uncovered*, never as zero.

core@vc will pin A1-A8 engine-side with mutation-verified tests, **mutating toward
suppress-everything**, since a guard that suppresses unconditionally passes every "must not re-file"
assertion. That is the same discipline this side found necessary (§9.1) and it is the right
mutation direction for a suppressor.

### 3.2 Rulings — settled

**A7 — RULED, split three ways, and all three are PERMANENT from the plugin side. Nothing in A7
ever retries.**

| A7 case | Ruling |
|---|---|
| Conversation **deleted** | Permanent rejection, dead-letter. There is no row to attach to, and `canonical_message_sources.canonical_turn_id` is `ON DELETE CASCADE`, so a write would either fail or orphan under a successor. |
| **Merged / attached** | The engine resolves through its own alias chain to the surviving conversation and unions there, subject to the fence. |
| **Ambiguous / unresolvable** | Permanent rejection. |

**Rejection taxonomy — RULED.** The receiver returns a typed reason; the plugin classifies on that
rather than on the HTTP status, because two notions of "permanent" are two rulers and they drift
the moment either side adds a case.

- **Permanent (drop and count, never retry):** `malformed_identity`,
  `unresolvable_tenant_scope`, `conversation_deleted`, `ambiguous_alias_resolution`,
  `fence_rejection`.
- **Retryable:** `store_unavailable`.
- **Anything unrecognised — an unknown reason, an unreadable status, a transport error — is
  UNKNOWN, and unknown is RETRIED.** A record is never discarded because its failure could not be
  parsed.

A rejection returned *inside* a 200 body fails the delivery rather than unlinking a record that was
never accepted. HTTP 200 is metadata, not evidence of acceptance.

**The endpoint — NOT core@vc's to grant.** The OSS engine exposes no non-dashboard REST surface;
prepare/ingest lives in cloud, so the path and status codes are **cloud@vc's**. core@vc owns an
engine method taking `(conversation_id, observed: [...])` with union semantics plus the typed
rejection split above. The strawman body stands, and `observed_at` is now **load-bearing** — see the
fence in §5.4.

> **CONSTRAINT ON THE ROUTE, from cloud@vc's capture surface: the late path MUST NOT live under
> `/internal/`.** `should_capture_http_exchange` (`diagnostic_capture.py:59`) excludes `/internal/`
> outright, so siting it there makes the late path **structurally invisible to the only instrument
> that can prove arrival** — and invisible for precisely the half of the design that delivers out of
> order, after its turn, and after restarts. If it must live there, capturing it becomes a cloud
> change, made deliberately, rather than a blind spot discovered later when a zero looks like health.

**Still open:** whether the ingest response should **echo the ids it accepted**. That is the only
thing that would let the fast path retire a durable record (§4.2), and until it exists every id
carried on an ingest is also delivered by the late path. By I-3 that is a no-op, not a bug.

---

## 4. Plugin design

### 4.1 Conversation binding without `runId`

The reframe that makes §2.2 survivable: **turn correlation was never the requirement.** The engine
needs to answer *"was this message id authored by the bot itself?"* — a set-membership test, not a
turn join. So the loss of `runId` costs nothing, provided ids can be bound to a *conversation*.

They can, and without any cross-hook state:

Production runs `convIdentity: "stable"`. In stable mode `deriveConvIdentity(sessionKey, sessionId,
groupIndex)` (`index.js:2859`) returns `{convId: "sk:" + <key>, isStable: true}` for every recognised
scope — `discord:channel|guild|direct|group`, `telegram:direct|group|slash`, `web`, `main`, and any
key remapped by `conversationGroups`. **`sessionId` is read only on the non-stable fallback
branches.** `message_sent` carries `sessionKey` on the generic path (§2.3), so on Discord the
conversation id is a pure function of data already on the event.

This is strictly better than a sessionKey→conv map maintained across hooks: no stale-mapping window,
nothing to invalidate on VCATTACH or merge, no lifetime to get wrong.

**The binding gate, and the first line is the whole point:**

```
if (stableMode !== true)          -> DROP. (see below; v2 got this wrong)
identity = deriveConvIdentity(cleanInboundField(event.sessionKey), /* sessionId */ null, groupIndex)
if (identity.isStable !== true)   -> DROP the id, count the reason, return.
```

**Why the mode check leads, and why v2 was a P0 without it.** `deriveConvIdentity` is a *pure
derivation, not a policy*: given a Discord-shaped key it returns `sk:<key>` whether or not the
deployment is configured for stable identity. Real code routes through `selectConvId`, which checks
`stableMode` first and returns the session UUID otherwise. v2's pseudocode called `deriveConvIdentity`
directly and then asserted that `convIdentity: "session"` deployments "capture nothing" — **the
opposite of what that code does.** On such a deployment the base turns would ingest under a rotating
session UUID while the outbound ids were delivered under `sk:<sessionKey>`: a *different*
conversation, possibly one that already holds other traffic. That is wrong-conversation attribution
— the exact failure class this feature exists to remove, reintroduced by its own fix.

Shipped as an exported pure function (`outboundConvIdFor`) precisely so it is testable, with a
regression test that feeds it a perfectly valid Discord key in session mode and asserts `""`.

`selectConvId` is deliberately **not** reused: its fallback warning counts a different population
(sessions that reached prepare), and feeding outbound events into that counter would corrupt an
existing instrument in order to build a new one.

Never substitute a session id, never guess, never fall back to an ephemeral conv. A dropped id is
I-1 unknown and costs nothing. A misattributed id is an identity claim about the wrong conversation,
which is exactly the class of bug this whole effort exists to remove.

Consequences accepted deliberately:
- **Telegram is out of scope for v1** — no `sessionKey` on the event (§2.3), so the gate drops
  every Telegram id. Correct under I-1, and honest: v1 does not fix Telegram, and the instrument
  will print that rather than let it read as "Telegram had no outbound messages."
- **`convIdentity: "session"` deployments capture nothing** — now *because the gate's first line
  says so*, not because of the absent `sessionId` v2 wrongly relied on. Boot logs it explicitly and
  the report prints `convIdentity=session`, so nobody reads a silent zero as health.
- Concurrent turns in one session cannot be told apart — and **do not need to be.** Both turns
  belong to the same conversation, and the artifact is a per-conversation set. The one caveat the
  SDK doc raises against `sessionKey` correlation does not apply to a set.

### 4.2 Two paths — and the ordering between them is a correctness property

v2 said ids present at body-construction ride the ingest and *"otherwise"* enter the queue. That
"otherwise" was a P1: **exactly-one-path classification is the unsafe optimization here.** An id
classified as fast and then lost to a failed ingest disappears with nothing recording the loss, and
an id witnessed *between* the snapshot and the POST can miss both paths depending on how "otherwise"
is implemented. Duplicates are safe by contract (I-3); classification is not.

**So the order is fixed, and it is not an implementation detail:**

1. **Durable first, always.** Every valid witnessed identity is written to the delta queue (§5)
   before anything else happens to it. This is the only step that can lose nothing.
2. **The fast path is an opportunistic, NON-CONSUMING snapshot** of what is already pending for that
   conversation, folded into the ingest body. It is a *permitted duplicate*, never an ownership
   transfer. Reading the snapshot does not remove anything — pinned by a test, because "reading
   consumes" is exactly the refactor that would silently reintroduce the loss.
3. **A record leaves the queue only on an exact idempotent acknowledgement** from the receiver.
   Today the ingest response acknowledges nothing, so today the fast path retires nothing; the late
   worker is the only thing that can unlink a record. If core@vc adds an echo of accepted ids to the
   ingest response, step 3 can also fire on the fast path and the double-send disappears. Until
   then the double-send stands, because by I-3 it is a no-op and correctness beats one request.

**Two consequences stated rather than left implicit:**
- With **no `latePath` configured there is no durable backstop at all**, so an id witnessed after
  its own ingest is simply lost. That case is counted (`unbackedFast`) and printed, so a capture
  number can never quietly exclude it.
- The exact-completion payload is **deliberately excluded from the fast path.** `queueExactCompletion`
  fingerprints the whole payload and dead-letters a re-queue whose fingerprint differs, so folding a
  time-varying id set into it would manufacture a brand-new way to lose a real user's turn. The ids
  ride only the fire-and-forget legacy ingest, where a changed body costs nothing.

Which path carries the traffic depends on whether delivery precedes `agent_end`, **which I have not
measured and will not guess.** §6 Phase A measures it. Both paths are built regardless, because
either could be the tail case and neither may be the only one.

### 4.3 What is never sent

No message content. The event carries `content`, and it is not used, not hashed into the record, and
not logged. The artifact is an identity set: platform, bot account, channel, message id, observation
time. Content-matching was considered as a correlation aid and rejected — it would put outbound text
in a new store for no gain over §4.1, which needs no content at all.

---

## 5. The delta queue

### 5.1 Why NOT the completion outbox (codex P0-1, accepted in full)

Two independently fatal reasons, both verified in `index.js`:

**Ordering.** `completionOutboxHeads` (`index.js:3897-3905`) selects exactly one head per
`conv_id`, and `deliverCompletionOutboxRecord` only unlinks on success. A blocked id follow-up would
therefore sit at the head of its conversation and **queue every later record behind it — and those
records carry real users' disclosures.** That converts an attribution repair into invisible
persistence loss: precisely the failure I-1 exists to prevent, introduced by the fix for it.

**Admission.** `queueExactCompletion` (`index.js:3699-3711`) throws unless the payload carries a
valid `exact_source_admission` prepare generation token **and** an inbound `source_message_id`. An
id-only delta has neither and never can — it is about an *outbound* message and is not a completion.
`readCompletionOutbox` (`:3764+`) additionally dead-letters records that fail the fingerprint and
generation checks. An id record entering that store is quarantined by design.

### 5.2 Shape

Distinct directory, distinct worker, distinct retry domain:

```
~/.openclaw/state/virtual-context/outbound-id-queue/<deployment_id>/<record_key>.json
```

`<deployment_id>` from the existing `completionDeploymentScope(baseUrl, vcKey)` so per-agent VC keys
get their own queue, matching the completion outbox's per-key isolation for the same reason
(`index.js:3143-3147`): a drain scheduled for one key can never see another key's records, so
startup must drain **every** configured key or an agent's ids sit forever with no error anywhere.

**Shared helpers, not shared domains** (this is the exact line codex drew): `durableAtomicWrite`,
`durableUnlink`, `fsyncDirectory`, `completionDeploymentScope` are reused verbatim. Ordering,
head selection, retry schedule, dead-letter policy and worker are new and separate.

`record_key = sha256(JSON.stringify(["outbound-id/v1", deployment_id, conv_id, identity_key]))`
where `identity_key` is the I-2 tuple joined on **NUL**. Re-witnessing the same message therefore
resolves to the same path and is idempotent at the filesystem level.

**Three things about that encoding are load-bearing, and v2 had none of them:**
- **Versioned preimage.** If the encoding ever changes, old keys must not alias new ones. A
  collision here is two different messages sharing one record.
- **NUL, not a printable separator.** With a printable separator,
  `(account "a b", channel "c")` and `(account "a", channel "b c")` produce **one key** — two
  different messages sharing an identity, which is the exact bug class this feature exists to
  remove. NUL is safe *only because* every component is validated to contain no control characters.
- **Validation lives in the key function.** Non-empty, length-bounded, no control characters,
  already-canonical, platform lower-cased. It runs where the identity becomes a key rather than
  wherever a caller remembered to validate, because records read back off disk are untrusted input.
  A malformed component returns `""` — a refusal — and never throws, because this code runs on the
  same call path as a turn.

**The empty-string trap, recorded because it shipped and a test caught it:** `cleanInboundField("")`
returns `""`, so an empty field *round-trips successfully* through a canonicalization check and was
accepted as exact. An empty component collapses the namespace. The check now rejects empties
explicitly.

**Rotated and removed keys orphan their queue (P1-6).** The directory name is a hash of
(baseUrl, vcKey), so rotating a key file or deleting an `agentKeyFiles` entry leaves a directory
**no worker can ever schedule a drain for**: its records sit forever with no delivery, no expiry and
no error anywhere — the same silent failure the per-key startup drain exists to prevent, walking in
through credential rotation, and accumulating without bound across rotations. Startup therefore
**inventories every directory on disk**, not just the reachable ones, and prints
`scopes / configured / drainable_scopes / drainable_records / orphaned_scopes / orphaned_records /
oldest_orphan_age_ms`. An orphan is reported by name and count; it is never silently deleted and
never silently kept, and the line says in its own text that orphaned ids are **unknown, never
negative evidence**.

### 5.3 Non-blocking is the defining property

**Records are independent. There is no per-conversation head.** Every due record is attempted on
each drain; a record that fails backs off on its own schedule and blocks nothing. This is the whole
reason the queue exists separately, so it is stated as an invariant and pinned by a test, not left
as a property of the current loop shape that a later refactor can quietly remove.

**Bounds, with the actual numbers — "max records" as prose let two implementations differ by
orders of magnitude and both claim conformance:**

| Bound | Value | Why |
|---|---|---|
| max records per deployment | 512 | overflow drops **oldest**, counted |
| max age | **30 min** | the only lifecycle fence available to this side; see §5.4 |
| base / max backoff | 500 ms / 5 min | capped exponential, 20% jitter |
| drain limit per pass | 64 | each record attempted at most once per pass |
| pending set (in-memory) | 256 conversations x 64 ids, 15 min TTL | LRU, evictions counted |
| carried per ingest | 32 | newest-first |

Enforcement runs on **every drain pass and at startup**, not only when something is queued.

Timestamp handling is part of the bound, not incidental: `Date.parse(x) || now` reads a valid epoch-0
stamp as *freshly enqueued* and lets an unparseable stamp evade the age bound entirely, and
`Date.parse` coerces, so a numeric field parses as a far-future year. All three make a record
**immortal**, and an immortal record is one that can outlive its own conversation. Timestamps are
parsed only from strings; unparseable means maximally old (drop); future means clamped to now so it
still ages.

**Counters, cumulative and printed together** — a counted drop is the numerator for one event, not
how much of the witnessed population was lost: `events`, `success`, `withMessageId`,
`withSessionKey`, `withRunId`, `witnessed`, `duplicates`, `carried`, `queued`, `queuedDuplicate`,
`queueRefused`, `unbackedFast`, `evictedPending`, plus every refusal **by name**, plus queue depth
and oldest age from the inventory line. Dropping is I-1-safe; unbounded growth is not.

### 5.4 Lifecycle fencing — the SHIP GATE

`runId + conversation` is **not** a lifecycle fence — codex is right, and §2.2 makes it moot since
there is no `runId` to misuse. The real hazard remains: a queued id delivered after its conversation
has been deleted and recreated, or merged, would attach an identity claim to a successor. The
completion outbox solves its version of this with a prepare generation token, which an id-only
record cannot obtain (§5.1).

**RULED by core@vc: (a), engine-side — but reframed, because my framing was unbuildable.**

I proposed an engine-issued generation token captured before enqueue and rejected on mismatch. A
receiver comparing generations needs the id to *carry* one, and an id-only record can never obtain
one — the same reason it cannot enter the completion outbox (§5.1). So the fence has to be derivable
from what is already sent:

> **Reject any id whose `observed_at` precedes the start of the conversation's current lifecycle
> epoch.** An id observed before this incarnation began cannot be evidence about this incarnation.

`lifecycle_epoch` bumps only on resurrect — `increment_lifecycle_epoch_on_resurrect`
(`storage/postgres.py:4187-4211`), a single guarded `UPDATE ... WHERE phase='deleted' RETURNING`, so
it cannot double-bump. **Nothing is required of the plugin beyond `observed_at`, which it already
sends.**

**Three things core@vc owes, stated as owed rather than assumed:**
- **The epoch-start timestamp does not exist yet.** The bump stamps `updated_at`, which many other
  writes also touch, so it is unusable as an epoch start; a dedicated column has to be added at that
  same statement. **Until it exists the fence cannot be implemented, and core@vc will not ship
  suppression without it.** A hard gate on the engine half.
- **The fence leans on the two clocks agreeing.** Rejection is the safe direction — it degrades to
  today's behaviour — so the skew margin is applied so it rejects MORE, not fewer.
- **Keep (b).** The short queue max age is **not** a mitigation to be embarrassed about: it is the
  cover for the window where clocks disagree, it is cheap, and it composes with (a). It stays.

**SHIP GATE, stated as a hard condition rather than an intention:**

> **The late path may not be enabled in production until the generation token exists.** Concretely:
> `outboundIdCapture.latePath` stays unset, so the durable queue never delivers. The code is built,
> unit-tested and inert. `mode: "observe"` and the fast path are unaffected — neither can outlive a
> turn, so neither can cross a lifecycle boundary.

This is also why the shipped default is `mode: "off"` and why `latePath` is a separate switch rather
than implied by `carry`: **the unsafe capability has to be separately armable, or "we'll be careful"
is the only thing standing between a queued id and a successor conversation.**

---

## 6. Build phases

**Phase A — instrument only. No network, no behavior change.**
Subscribe `message_sent`; log field *presence* (never content) and the relative ordering against the
ingest for the same session. Deploy, observe real traffic, and produce the field-presence table
with its N. This is what converts §2 from static analysis into measurement.

Phase A also serves as the positive control demanded by `feedback_silent_instrument_not_evidence.md`:
until this hook has fired at least once in production, "no ids captured" and "the hook is broken or
never reached" are the same observation.

**Every metric here measures presence, not correctness**, and the instrument's printed output says
so in its own text. Two limitations are sharper than v2 admitted, and both are now printed on every
report line:

- **`events=N` is a NUMERATOR WITH NO DENOMINATOR.** This process cannot count how many deliveries
  actually happened, so *"the hook fired for every delivery"* and *"the hook fired for one delivery
  in a hundred"* produce identical output. The report prints `capture_rate=UNKNOWN` — not omitted,
  **named**, because an omitted rate reads as an unimportant one. The denominator has to come from
  the gateway's own delivery log: a second, independent instrument. *(Two instruments or it doesn't
  survive.)*
- **Ordering against ingest is NOT reported at all.** v2 proposed correlating on `sessionKey`, while
  §2.2 of the same document records that `sessionKey` cannot disambiguate concurrent turns in one
  session — and the plugin already treats same-session concurrency as normal for groups. Any
  ordering claim built on it would pair an outbound event with a turn it may not belong to and could
  report healthy ordering while missing deliveries sat outside both numerator and denominator. It is
  reported as **UNVERIFIED**, which is the honest answer, rather than session-correlated, which is a
  fabricated one.
- Structurally invisible populations, printed by name: §2.4's N-1 non-tail chunk ids; every Telegram
  id; everything under `convIdentity: "session"`. A zero in any of them is **UNCOVERED**, never
  negative evidence.

**Phase B — capture and carry.** Fast path + delta queue + worker, per §4/§5, against the §3
contract as accepted by core@vc.

**Phase C — joint acceptance.** §3.1, run against the real endpoint. Installation is not
verification, and neither is a green unit suite.

---

## 7. Verification surface

**The v1 verification plan does not work** (codex P1, accepted). `modelCallCapture` records complete
`llm_input` / `llm_output` hook payloads and **nothing else** — it has never observed a `vcPost`
body, so it cannot show what landed on `/api/v1/context/ingest`. Any assertion built on it would
have been measuring a different thing entirely.

Surfaces that do work:

1. **cloud@vc's captured request bodies — ANSWERED, and the answer came with a trap worth
   recording.**

   **There are TWO capture surfaces and the obvious one is useless here.** The Postgres
   `request_captures` table — which is exactly where "cloud holds captured request bodies" leads —
   **contains no request body at all.** It is a metrics projection: `inbound_tokens`,
   `prepare_breakdown`, `context_tokens`, `message_preview`, ~48 keys of counters and timings, 870
   rows back to April. Plausible-looking JSON that **structurally cannot answer the question.**
   Building on it would have produced a confident verification plan measuring the wrong thing.

   The real surface is gzipped JSON on disk:
   `/data/tenants/diagnostics/http-captures/{stamp}_{pid}_{capture_id}.json.gz`.

   | Question | Measured answer |
   |---|---|
   | Full body or projection? | **Full, verbatim.** `vc_cloud/main.py:305` takes `await request.body()` as raw bytes **in middleware, before routing, parsing or model validation**, and stores `{encoding, text, bytes, sha256}`. |
   | Do unknown top-level fields survive? | **Yes.** Nothing deserialises the body into a schema before it is written, so there is no place for an unknown field to be dropped. Redaction touches headers and credential-looking query-param values **only** — never the body. |
   | Retention | **~3.1 days, not the configured 7.** The `max_files = 2500` cap binds; the age and byte caps do not. Measured on prod: exactly 2500 files, 41 MB, ~810 captures/day. |
   | Scope | **One global directory, NOT per-tenant.** Captures compete with all fleet traffic for 2500 slots, so the window shrinks as traffic rises. **Pull evidence promptly; absence of an old capture is evidence of nothing.** |
   | Enabled for the prod key? | **Yes**, no env override on the container; the current ring holds 571 `POST /api/v1/context/ingest`, all 571 with a body. |
   | Arrived-and-rejected vs never-arrived | **Cleanly separable.** Capture runs before routing and also on the exception path: rejected ⇒ a file exists with the full body and a 4xx/5xx `status_code`; never-arrived ⇒ **no file at all**. Match a specific send via `request.body.sha256`. |

   **Two limits from cloud@vc, carried verbatim because they are easy to lose:** a capture proves
   **arrival, not persistence** — "did it land in the store" still needs a read-back against
   `facts` / `canonical_turns`; and the ring is volume-driven, so an absent old capture means
   nothing either way.

   **One question this does NOT answer, and it is the one gating the fast path.** Capture happens in
   middleware *before* routing, so it proves an unknown field survives **into the capture**. It says
   nothing about whether the ingest **handler** accepts a request carrying an unrecognised top-level
   field or 4xx's it — by cloud's own point, both outcomes produce a capture file, distinguished only
   by `status_code`. Asked of cloud@vc as either a read-only scan of the current ring or a single
   probe POST. A rejection can no longer cost a turn (§4.2), but *safe* is not *working*: if the
   handler rejects, every fast-path send doubles the request count and delivers nothing.
2. **The vitest suite on the VPS** — `/root/vc-plugin-test/run-tests.sh`. Checksums itself against
   the deployed `index.js` and refuses to run on a mismatch, which is what makes green mean *the
   shipped code passes*. Baseline 17 files / 226 tests. Cannot run on the Mac (version mismatch,
   not a broken install).
3. **Phase A's own journal lines** — ordering and field presence in production, with N.
4. **Read-only SELECTs** against the store for the engine-side effect, per the DB protocol.

**No user is asked to send a test message, ever.** Disposable-session probes only — with the known
limitation that a CLI-driven probe has no outbound channel delivery, so it cannot fire
`message_sent` at all. Phase A on real traffic is therefore not a convenience, it is the only
instrument that can observe this event.

---

## 8. Risks

| Risk | Handling |
|---|---|
| Engine treats a partial set as complete | I-3 + A5. The largest safety risk in the design, and it lives on the other side of the contract. |
| Stale id lands in a successor conversation | §5.4. Open, core@vc's call, short queue age until settled. |
| Telegram silently uncovered | §4.1. Instrument prints it as *uncovered*, never as zero. |
| Delta queue grows unbounded during an outage | §5.3 bounds; drop-oldest with a counted log line. |
| Zero ids captured reads as healthy | Phase A positive control. Until the hook has fired, silence is not evidence. |
| A later refactor gives the delta queue a per-conversation head | §5.3 pinned by a test, not left as an emergent property. |
| Ids delivered under the wrong conversation in session mode | §4.1 mode gate, pinned by a regression test that feeds a valid key in session mode and asserts a refusal. |
| A rotated VC key strands a queue nothing can drain | §5.2 startup inventory reports orphaned scopes by count and age. |
| A malformed record becomes immortal and outlives its conversation | §5.3 timestamp rules; unparseable is treated as maximally old. |

---

## 9. Implementation review — second Codex pass, against the shipped code

The spec review checked a design. This one checked `index.js` and both test
files, and returned **1 P0, 7 P1, 1 P2**. Eight were real. What they were, and
what changed:

| # | Defect | Why it mattered |
|---|---|---|
| **P0** | The id set was merged into **the only completion request for the turn**, and a rejection was merely logged | An old receiver or a schema rejection would have taken **the human's disclosure** down with it. I-4 inverted: metadata failure degrading the turn. A metadata-bearing ingest failure now **retries the original payload unchanged**, and the dropped ids are counted. |
| P1 | Pending ids keyed by `conv_id` alone | `conversationGroups` can map members routed through **different** `agentKeyFiles` onto one grouped conv id. An id witnessed under key A could ride an ingest authenticated by key B — and with two agents sharing a Discord account and channel, the full I-2 tuple matches and suppresses a real reply **in the wrong tenant.** Now keyed `(deployment_id, conv_id)`. |
| P1 | `void scheduleOutboundIdDrain(...)` | `void` does not swallow a rejection, it **detaches** it, and the hook's synchronous try/catch cannot see it. Under the host's unhandled-rejection policy a *metadata* filesystem error could terminate the gateway. All launches now go through a catching launcher, and the worker's outer promise never rejects. |
| P1 | Observe mode could drain | The startup drain checked only `latePath`, so switching a deployment to `"observe"` would deliver everything already queued and **activate suppression** — the opposite of a measurement-only rollout. Now requires `carry && latePath`. |
| P1 | 64 slow records could starve every newer one | Records were ordered oldest-first with a per-pass cap, and the failing cohort's short backoffs expire *during* the pass, so it was re-selected every time and records past the limit were never attempted. **Starvation without a formal head.** Now ordered fewest-attempts-first. |
| P1 | Future timestamps were immortal | `Math.max(0, now - parsed)` looked like a clamp but persisted nothing, so age read 0 on **every** scan until the wall clock caught up — and a record that outlives its conversation is exactly the §5.4 successor hazard. Now dropped beyond a minute of skew. |
| P1 | The inventory could stop the plugin loading | An unguarded `readdirSync` in a **diagnostic** called during registration — a metadata report taking down memory for every conversation on the host. Also reported unreadable directories as `records=0`, identical to empty, and called a scope "drainable" on a credential match alone. Now caught, and it distinguishes **held / orphaned / unreadable**. |
| P1 | Synchronous fsync on the delivery path | `message_sent` is a synchronous fire-and-forget callback; the durable write does mkdir + open + write + fsync + rename + dir fsync. Deferred off the hook's stack. **This is a mitigation, not a cure** — the write still blocks the loop when it runs. Acceptable only while delivery stays disarmed; the real fix is an async or off-thread write and it is written down as owed. |

### 9.1 The P2 was the most useful finding

The review's last point was that **eleven named tests would still pass against broken code** — vacuous assertions, blacklists that miss anything unnamed, length-only checks, loops over an empty collection.

That was worth more than the individual bugs, so it was checked rather than accepted: a mutation harness (`scripts/mutate-outbound-id.py`) flips one shipped safety property at a time and requires the suite to fail. First run: **8 mutations, 3 caught, 5 SURVIVED.** Five safety properties I had just "verified" were untested. The gaps are now covered — including two **positive controls**, because a test asserting "nothing was delivered" passes trivially against an implementation that can never deliver anything at all.

Current state: **8 mutations, 8 caught, 0 survivors.** Re-run it after any change to this feature; a green suite alone does not mean the properties are held.

## 9.2 Phase A results — MEASURED 2026-08-20, no longer static analysis

Deployed to prod `observe` at 15:20 UTC, `carry` at 15:53 UTC.

**Positive control SATISFIED 15:49:56 UTC.** Until that moment "no ids captured" and "the hook is
broken or never reached" were the same observation. They are not any more.

```
events=1 success=1 withMessageId=1 withSessionKey=1 withRunId=0
witnessed=1 duplicates=0 refused[none]
registrations=4 sendingHook=1 sent_per_sending=1.00 capture_rate=UNKNOWN
```

| Claim | §2 said (static) | Measured | N |
|---|---|---|---|
| `runId` not plumbed on the outbound path | not populated | **`withRunId=0` — CONFIRMED** | 1 |

> **`withRunId` measures the OUTBOUND hook's field only. It is 0 and that is correct. It says
> nothing about `ctx.runId` on the turn path, which is populated — see §10.3.0.**
| `messageId` present on the generic path | yes | `withMessageId=1` | 1 |
| `sessionKey` present on the generic path | yes | `withSessionKey=1` | 1 |
| The identity projects and binds | designed | **`refused[none]`** — full tuple, no refusal branch touched | 1 |

**`withRunId=0` is the load-bearing confirmation.** The SDK doc was accurate, there is no free
correlation key, and the conversation-binding reframe of §4.1 was *necessary* rather than merely
convenient. Good news that had not been verified would have been the worst available outcome.

**What N=1 does NOT establish, recorded so the numbers above cannot be over-read:**
`sent_per_sending=1.00` is **not a coverage rate** — it is one event, and what it establishes is
narrower: the pre- and post-delivery hooks fired in the same process for the same message, so the
wiring is live. `withRunId=0` is one observation consistent with the doc, not proof it never
populates. `capture_rate` remains **UNKNOWN and known-unobtainable** (§7).

#### 9.2a THE INDEPENDENT DENOMINATOR — and the instruction that produces a false defect if given alone

**`sent_per_sending` compares the plugin against itself.** Both hooks are host-dispatched in one
process, so **if the host stops dispatching, both fall to zero together and the ratio stays at
1.00.** A perfect score and a dead instrument are indistinguishable from the value alone.

**The real denominator is outside the plugin** — the host's own dispatch line:

```
journalctl --user -u openclaw-gateway | grep -c "hooks] running message_sent"
```

Measured 2026-08-21 06:12Z and again at 06:17Z: **`host=3 / events=3`, then `host=4 / events=4`.**
That is a health claim with teeth, because the denominator keeps counting when the plugin stops.

> **DO NOT GIVE THAT INSTRUCTION WITHOUT THIS SENTENCE.** The report prints for `events ≤ 5` and
> then every 25, so **between events 6 and 24 the printed figure is STALE** and a comparison against
> a live host count silently becomes *"host now vs plugin then."* A reader at event 11 sees
> `events=5`, counts 11 dispatches, and derives a **6-event shortfall that does not exist** —
> following the instruction exactly, and going on to hunt for dropped events.

**The comparison is valid ONLY when the report is fresh.** Check that the report's own timestamp is
the most recent one, or force a fresh reading, before dividing anything.

**This is the same shape as the `18 vs 5` that was deliberately not published:** the previous
process dispatched 18 while its last printed report said `events=5`. **That gap was the print
schedule, not loss**, and quoting it would have manufactured a defect out of a reporting cadence.

> **A number with no stated age cannot be told from a stale one — including by the person holding
> it.** The fix is to attach the age to the value, not to remember it.

#### 9.2b DURABLE vs EPHEMERAL — a cumulative count that can return to zero

**Observed 2026-08-21 12:40Z:**

```
was  rows=6  offers=15  declines[epoch_start_unknown:1, :2, :3]
now  rows=6  offers=0   declines[]
```

**Six rows cannot come from zero offers.** The contradiction is the only thing that made this
readable — and it was readable **only because a durable number was printed on the same line as an
ephemeral one.**

**Cause: a deploy recreated the receiver's container at 12:39:59Z and reset `docker logs`, which is
where `offered` / `declined` are derived from.** Nothing regressed; `offers=0` was a log stream four
minutes old.

| Field | Nature |
|---|---|
| `rows` (`SELECT COUNT(*) FROM bot_outbound_messages`) | **DURABLE.** Survives deploys. **This is the number.** |
| `offered` / `declined` | **EPHEMERAL.** Derived from a container log stream that every deploy destroys — **three times in one night.** Commentary, never a measurement. |

> **A cumulative count read from `docker logs` is structurally ephemeral no matter how carefully it
> is computed.** Making it durable needs a table, not better parsing.

**RULE: print a durable number beside every ephemeral one.** Without `rows=6` on that line,
`offers=0` reads as a clean and alarming fact. **This is the third instance of the same shape in
twelve hours** — `ackAccepted=0` meaning *nothing measured*, a receiver-side predicate reading `PASS`
on emptiness rather than coverage, and this — **and it is the first one caught at the moment it
happened rather than afterwards, purely because of the adjacency.**

### 9.3 Two instrument defects found by deploying, not by testing

Both would have corrupted the first real measurement rather than any user-facing behaviour — the
worst place for a defect, because the number would have been believed.

- **`register()` runs once per AGENT CONTEXT, not once per process** — measured: four calls, one
  PID. Stats were created inside `register()`, so there were **four independent counters printing
  four interleaved reports into one journal, each with its own N.** Exactly the denominator
  confusion this instrument exists to prevent, committed by the instrument. Counters moved to module
  scope; the report prints `registrations=N`. **The existing tests could not have caught it**: every
  one called `vi.resetModules()` before registering, so each registration got a fresh module and the
  shared-state defect was invisible by construction.
- **The report printed at event 1, then nothing until event 25.** During the measurement phase the
  running count was unreadable from outside the process — two firings and twenty looked identical.
  Now prints for each of the first five, then every 25.

### 9.4 An observation raised, then RETRACTED by a wider window

`[vc] ingest OK` read **0** across both post-deploy windows while outbound deliveries occurred,
which looks like a gap in the *other* direction: a delivery the memory layer never sees.

**It was not.** Adding a per-agent-scope breakdown made the real question askable — *which* agent —
and the answer was `vast`. Over 7 days `vast` shows **311** prepare/ingest lines on Discord against
468 fleet-wide. **The zero was a short-window artifact**: two post-deploy windows of ten to twenty
minutes with near-zero traffic, in which one delivery happened to land without a completed turn
beside it. Two observations at N=2 looked like a pattern and were a coincidence.

Recorded rather than deleted, because **flagging it uninterpreted and then killing it once the
denominator was large enough to speak is the intended lifecycle of an observation** — and because a
document that only preserves the concerns that turned out to be real teaches a false hit rate.

---

## 9.5 Where the chain actually stands — measured, and none of it is the plugin

The plugin half is the **only proven-correct link**, and that is worth stating precisely rather than
as a boast: it is proven because it was *measured on the wire*, not because it was reviewed.

| Layer | State | Evidence |
|---|---|---|
| **Plugin — witness, project, bind, carry** | **WORKING** | `carriedExact` 0→1 at 16:00:10, and capture `d74affd47ad44c328adaa4e2678778c2` at 16:00:09.675, **HTTP 200**, on `/api/v1/tools/__vc_exact_source_ingest_v2` — a Discord guild channel. Two independent instruments, same send. |
| Cloud — carry the field into metadata | **BLOCKED** | `_take_user_turn_metadata` pops only `_USER_TURN_PROVENANCE_FIELDS` and rebuilds metadata from a closed keyword allowlist, so the key never reaches `current_user_metadata`. |
| Engine — reach the write path | **BLOCKED** | `CompositeStore` forwards 191 methods explicitly with no `__getattr__`; `record_bot_outbound_messages`, `resolve_channel_namespace` and `is_bot_authored_message` are none of them. `AttributeError` observed in prod. |
| Engine — accept an entry | **BLOCKED** | The recorder declines 100% of entries as `unresolvable_tenant_scope`; the scope it needs is stripped by its own reader and absent from config. |
| **Ledger `bot_outbound_messages`** | **0 rows** | Cannot fill from any source today. |
| Ghost subject-lane facts | **~97% of the lane.** Arrival rate: **DO NOT QUOTE A NUMBER FROM THIS DOCUMENT.** | cloud's instrument. The figure has been revised **three times in one day** — ~300/hour (retracted, §9.6.3), then ~22/hour, then ~49 in the last hour against 442/24h (≈18/hour averaged). Those last two may both be honest on a bursty process measured at different moments, or the instrument may still be off; **this side cannot adjudicate it and should not try.** Read it live from cloud's gate check, beside traffic volume, at the moment the number is needed. The total is not a trend either: compaction churns facts, so it drifts downward while the lane keeps filling. |

**The operational consequence, stated so nobody re-derives it painfully:** *"zero rows in
`bot_outbound_messages`"* is **not** evidence that the capture is broken. That table cannot fill
regardless of what the plugin does, so anyone using it as a success signal will debug correct code.
**Use the capture ring instead** — it proves arrival, which is the part this side owns.

### 9.6 THE FAILURE CLASS — one design property, four instances in one day

Everything below is the same defect wearing different clothes:

> **Two sides canonicalise the same identifier differently, and the disagreement fails SILENTLY TO
> ZERO rather than loudly to an error.**

| # | Where | The two rulers | How it would have presented |
|---|---|---|---|
| 1 | Identity projection | `ctx.channelId` (transport name, `"discord"`) vs the physical channel snowflake the inbound path stores | Every observation in one channel namespace; **never matches**; reads as "no ids captured yet" |
| 2 | Wire key, across my own two paths | `observed_outbound_messages` on the legacy ingest vs `_vc_agent_outbound_ids` on the exact path | A carrier forwards one, drops the other; **half the traffic silently uncovered** |
| 3 | Wire vs metadata namespace | The engine's `_vc_`-prefixed **metadata** key used as a **wire** key | Receiver reads its key, finds nothing; **ledger stays empty with no error anywhere** |
| 4 | *(not this spec's, but the same shape)* | A fact recorded as `off tesa` vs a query expanding to `tesamorelin` | The record is never a **candidate**; reads as a ranking loss, is a **tag miss** |

**This is not four bugs. It is one design property with four instances**, and the system exhibits it
at the wire, at the metadata boundary, and at the tag layer.

**The actionable form of the rule, sharper than "it is hard to keep track":**

> **An identifier that crosses a process boundary needs exactly ONE definition. Every place either
> side writes it down separately is a place they can diverge silently.**

That is why the receiver defining its wire field **as** the reader key is a stronger guarantee than
a convention two teams have to remember, and why this side keeping a **superset** of decline names
absorbed a rename shipped after it stopped looking. Both are the same move: **reduce the number of
independent copies.** Of the blockers hit on this feature in one day, at least three were an
identifier written down twice. Every instance produces a **zero**, and
a zero is indistinguishable from "nothing happened yet" — which is why every one of them needed an
instrument that could tell *not measured* from *none found*, and why none of them would have been
caught by a passing test suite.

**The only defence that worked, all four times: check the running artefact, not either side's
description of itself.** Instance 3 was settled by reading the deployed container while two teams
held confidently opposite beliefs about the same constant.

### 9.6.0 How to read a decline — the three outcomes are NOT interchangeable

The recorder answers with counts keyed by outcome. **Reading one as another is how this feature
gets reported as broken when it is working, or working when it is broken.**

| Outcome | Means | Action |
|---|---|---|
| `accepted` / `duplicate` | The identity is on record. `duplicate` is a **success**, not a failure. | None. The chain is closed. |
| `epoch_start_unknown` | The conversation's epoch boundary **has never been written**. **EXPECTED** until the backfill is applied by an explicit admin command. | **Do not raise this as a bug.** |
| `fence_rejection` | A genuine stale identity: `observed_at` precedes a **known** boundary. | Correct behaviour. The decline now logs `observed_at`, the epoch, and the boundary compared against. |
| anything unrecognised | Unknown. | **Retried, never dropped.** |

**This table exists because the distinction was destroyed once and nearly cost a false report.** The
two epoch reasons were collapsed into `fence_rejection`, which made a **permanently inert
conversation** — every identity declining forever — look like **one correctly-fenced stale record**.
The remedies are completely different, so the names must be.

**And an automatic seal is not the fix.** A first version wrote the missing boundary on whatever
traffic arrived first after deploy — a production data change as a side effect, with nobody
deciding it. It was backed out. **That is staged versus armed**, and the difference is who pulls the
trigger.

### 9.6.05 DEFECT: the outcome classifier exists, is correct, and is not wired in

**Distinct from every other finding here, and the plugin's own.** The instrument for reading a
per-identity outcome was built, tested, and mutation-verified — and **nothing can reach it.**

| | |
|---|---|
| `classifyOutboundIdResponse` | `index.js:4762` — the full taxonomy: accepted / duplicate / six permanent declines / one retryable / unknown-is-retried |
| Its only call site | `index.js:4880`, inside `deliverOutboundIdRecord` |
| Which is called only from | the drain worker, `index.js:4961` |
| Which returns early unless `latePath` is set | `index.js:4922` |
| And nothing is ever enqueued unless `latePath` is set | `index.js:5730` |

**`latePath` is unset in production. So the classifier has never executed against a real response.**

**The consequence is the sharp part.** `carriedExact` counts what the plugin **attached to a request
body**. It is a **producer-side** number, and it reads **identically** whether every identity was
accepted, refused, or discarded unread. Measured on 2026-08-20: `carriedExact=4` while the receiver
logged `offered=3, accepted=0, declined=fence_rejection:3`. **The plugin's own report showed nothing
wrong.** It is not merely unreported — it is **unobservable from this side.**

#### Is that configuration, or dead code? — CONFIGURATION, but only half the problem

**Setting `latePath` makes the classifier reachable.** It is a real, schema-declared config key
(`openclaw.plugin.json → outboundIdCapture.latePath`); with a valid rooted path plus `carry`, the
queue fills, the worker drains, and every gate above opens. **Nothing is dead.**

**But it fixes only the late path.** The fast path — the ids riding the ingest body, which is how
**every** identity has actually travelled so far — contains **zero** references to the classifier and
cannot reach it by any configuration. Verified: the classifier appears 0 times in
`ingestWithOutboundIds`.

**So the two repairs are different and neither substitutes for the other:**

| Path | Why it is blind | Repair |
|---|---|---|
| **Late** | `latePath` unset, so the classifier never runs | **Configuration** — plus an endpoint that exists |
| **Fast** | The ingest response carries **no per-identity outcome to classify** | **A wire change.** Cloud's item, specified below |

#### What the ingest response needs to echo

Stated by the consumer rather than guessed at. **Two tiers; the first is sufficient for
observability and is the ask.**

**Tier 1 — counts (sufficient, and cheap).** Echo the same outcome counts the recorder already
produces, scoped to the identities carried on *this* request:

```json
{"agent_outbound_ids_result": {"accepted": 0, "duplicate": 0,
                               "fence_rejection": 3}}
```

That alone converts `carriedExact` from a producer-side number into a real one: the report can print
**offered against accepted**, and a total-decline condition becomes visible on this side within one
turn instead of requiring someone to read the receiver's logs.

**Tier 2 — per-identity (only if cheap).** The same, plus `message_id` per outcome. **Not needed for
correctness** — under I-3 the set is additive and idempotent, so re-sending is free and nothing has
to be retired — but it is what would let the fast path drop a durable record on acknowledgement
rather than leaving that to the late path.

**What is NOT wanted, and would be actively harmful:** any field that could be read as a completeness
signal — a total, a denominator, an `all_accepted` flag. **Counts of outcomes for the identities in
this request only.** Non-membership must stay unknown (I-1).

### 9.6.06 The model reads two independent context sources; memory sees one

Established 2026-08-20 from captures and the deployed gateway, while investigating an unrelated
symptom. **Not a defect of this feature — a property of the system this feature lives in.**

| Source | Assembled by | Seen by VC? |
|---|---|---|
| `<conversation_context>` | **the Codex extension's context-engine projection** (`extensions/codex/src/app-server/context-engine-projection.ts`, `projectContextEngineAssemblyForCodex`), for codex-runtime agents | **NO** |
| the prepare response body | VC | yes — it is VC's own output |

**Measured on one real turn: `<conversation_context>` occupied chars 133,192–389,667 of a 380 KB
prompt — roughly 256 KB, about 67% of the model's entire input.**

**The plugin strips it before prepare, deliberately.** The reason is in the code above the parsing
constants: replayed history *"matches almost every retrieval query and buries the actual messages."*
That is a real defect prevented by a real fix. **The consequence is that VC answers "what is
relevant to this turn" while blind to two thirds of what the model will read**, and nothing measures
the gap. **Both halves look correct in isolation.**

#### The size is DERIVED, not configured — which is why config audits found nothing

```
codexContextProjectionMaxChars = resolveCodexContextEngineProjectionMaxChars({
    contextTokenBudget,                       <- a PER-RUN input, not a file
    reserveTokens  (config, default 20,000)
})
  -> normalizeRenderedContextMaxChars: clamp(v, 24,000 .. 1,000,000)
  -> truncateOlderContext(rendered, max)      <- drops OLDER context first
  -> resolveTextPartMaxChars = max / 4        <- per-message cap, clamp 6,000 .. 128,000
```

**A derived bound recomputed each run can move with nobody changing anything.** A config audit
cannot detect it, and neither can a version check — both were run here, both came back clean, and
**both were looking for the wrong kind of thing.**

**One number governs two effects**: how much history survives *and* how much of each message
survives. They cannot move independently.

**Recorded as conspicuous, not causal.** What would settle whether it moved is `contextTokenBudget`
on two specific dates, which is probably not recoverable from logs. **The decisive evidence is named
and believed unavailable — that is a complete answer, not an open question.**

### 9.6.07 The label/tag conflation — a same-ruler failure pointed inward

Worth its own entry because of how far a wrong conclusion travelled on it.

```
"Conversation context (untrusted, chronological, selected for current message):"   <- a LABEL
<conversation_context>                                                             <- the TAG
```

**Two different strings.** The label appears in the gateway **exactly once, in a list of prefixes to
OMIT** — so searching for it produced "no emitter exists in the installed gateway", which was
reported upward and nearly published as a standing operational fact: *"a component everyone consumes
and no one owns."*

**The tag has an owner and a knob, both found in minutes once the right string was searched.**
Everything downstream of the conflation was wrong, including a whole trail through `UntrustedContext`
— which is a genuinely different block with its own prefix.

**This is `feedback_checker_and_checked_same_ruler` pointed inward**: two strings that look like the
same thing, treated as the same thing, by the person auditing everyone else for exactly that. The
bundle is **not minified** (43–58 chars per line), so literal greps were reliable throughout — **the
tool was sound and the discipline was in choosing the string.**

### 9.6.1 ARRIVAL IS NOT CONSUMPTION

The strongest evidence produced for this feature was a captured request body: verbatim, sha256'd,
**HTTP 200**, on the exact-source path. It was cited to three people as proof the contract worked.

**It proved the field arrived. It proved nothing about whether anything read it** — and at that
moment the receiver was reading a different key, so the answer was *nothing did*.

**A 200 on a body whose key nobody reads is exactly the metadata-shaped success this document warns
about everywhere else** — the same class as `tokens_added=0`, `pending_indexing`, and an HTTP 200 on
a write. Having written that warning into §7 did not prevent committing it in §9.2.

The distinction to carry forward: **arrival is the sender's half and is verifiable from the wire.
Consumption is the receiver's half and requires the receiver's own signal** — here,
`AGENT_OUTBOUND_IDS conv=... offered=N accepted=N`, or a row in the ledger. Nothing short of that
closes the loop.

### 9.6.2 A fix does not immunise you against the misconception that produced it

`register()` runs once per **agent context**, not once per process. That was found, fixed, and
written up at §9.3 in the morning.

Three hours later, `[vc:outbound-id] enabled` was used as a **restart counter** — a line that fires
once per agent context, not once per process — and produced a false report of a gateway restart
during a change freeze. The correct answer was zero, from `MainPID` and `ActiveEnterTimestamp`.

**Understanding a defect well enough to fix it does not stop you reusing the misconception as an
instrument.** Prefer the authoritative source (the process identity) over a log line that correlates
with it.

### 9.6.3 A retracted rate, kept because the retraction is the lesson

An earlier draft of the surrounding reports cited **~300 mislabelled rows per hour**. **That figure
is wrong; the rate is 22.** The instrument compared a `text` timestamp column **as a string**, and
the stored format uses `T` where the comparison value used a space — `T` sorts above a space, so
every row from the same calendar date compared true regardless of time, collapsing every sub-day
window to "since midnight". Inflated 13.5x.

**The tell was in the instrument's own printed output: the 1-hour and 6-hour windows both returned
297.** Two different windows cannot honestly return the same count. *Printing the windows side by
side is what made it visible* — the same reason every verdict here prints its N.

**And the correction was itself corrected.** After ~300/hour was retracted, ~22/hour was reported,
and then ~49 in the last hour against 442/24h. **Three figures for one quantity in one day.** They
are not necessarily contradictory — a bursty process sampled at different moments produces different
hourly rates, and 442/24h averages to ≈18/hour, so a 49-hour is plausible. **But a quantity that has
moved by more than 13x and been revised twice is not one to build an argument on**, and it is
somebody else's instrument besides. The correct handling is the one adopted here: **cite the source,
never the number**, and read it live when it is actually needed.

### 9.7 The bug the harness could not have caught

The plugin shipped **two different wire key names** — `observed_outbound_messages` on the legacy
ingest and `_vc_agent_outbound_ids` on the exact-source path — because the first was a strawman that
predated the engine naming its reader key, and only one call site was updated.

**Every test passed throughout**, on both paths, because each path's tests asserted its own name.
Internally consistent and jointly wrong. The mutation harness could not reach it either: **a harness
tests code against its author's expectations, and the expectation itself was the defect.**

It surfaced only when an outside party asked for *the literal string this code sends today*. That is
a category that requires either a second party or a check against the actual wire — and the wire
check existed and would have caught it, which is a further argument for doing the capture pull early
rather than at the end.

Now one constant used by both paths, with a mutation pinning that they cannot diverge again.

---

## 10. Implementation status

Plugin half: `index.js`, `tests/outbound-message-id.test.js`, `tests/outbound-id-hooks.test.js`.
Suite 20 files / **356 tests** green, and **24/24 mutations caught** (`scripts/mutate-outbound-id.py`).

**Shipped and inert by default.** `outboundIdCapture.mode` defaults to `"off"`: no hook registered,
no byte changed on any wire. Nothing below is live until that config is set.

| Piece | State |
|---|---|
| `message_sent` subscription, presence counters, named refusals | shipped |
| I-2 identity projection with the inbound channel ruler | shipped, negative-control test |
| Mode-gated conversation binding (`outboundConvIdFor`) | shipped, regression test |
| Additive wire projection, no completeness bit | shipped, structural test |
| Non-consuming pending set with counted eviction | shipped |
| Durable delta queue: distinct dir, worker, ordering and retry domain | shipped, no-head test |
| Startup inventory incl. orphaned scopes | shipped |
| Report that prints its own limitations and `capture_rate=UNKNOWN` | shipped |
| Typed rejection classification (reason over status; in-200 rejections) | shipped |
| A9 multi-chunk lower bound, labelled as a bound | shipped |
| **Late-path delivery** | **built, unit-tested, GATED OFF** — §5.4 ship gate |
| Fast-path field name and late-path endpoint | **cloud@vc's call** (§3.2) |
| Phase A production measurement | needs `mode: "observe"` deployed |
| Phase C joint acceptance | surface ANSWERED (§7); blocked on the endpoint |

### 10.0 OPEN, AND STRUCTURALLY THIS SIDE'S: re-presenting declined identities

**Established 2026-08-20 by core, from the DEPLOYED tree rather than HEAD.**
`record_bot_outbound_messages` is reachable from exactly two places — `engine.py:2197` and
`proxy/state.py:3573` — **both on the live turn path** (the prepare that starts a turn, the ingest
that completes it). `git grep outbound` across `compaction_pipeline.py` and `compactor.py` returns
**nothing**. There is no sweep, no repair, no backfill and no replay on the engine side.

**So the completion path offers only what rides a live turn, and never re-presents anything.**
An identity declined once is declined permanently unless the SENDER offers it again.

**Consequence, and it is the one that matters for the ship decision:**

> **Sealing the epoch boundary makes every FUTURE offer acceptable and does nothing whatsoever for
> identities already declined.** They are two separate pieces of work.

| Work | Owner | State |
|---|---|---|
| Seal the epoch start | core@vc | specced, `specs/lifecycle-epoch-start-backfill.md`, admin-triggered |
| **Re-present already-declined identities** | **this plugin** | **NOT specced, not built** |

**Why it lands here:** the engine has no mechanism to re-offer, so re-presentation can only come from
the party that sends. This plugin already has the shape for it — a durable queue with idempotent
records — but it currently enqueues **only newly-witnessed** identities, holds them on a 15-minute
pending TTL, and has no path that re-sends something already carried.

**Two things any future design must not get wrong**, both learned tonight:
- **`epoch_start_unknown` is a PERMANENT decline in the taxonomy**, so a naive retry loop will not
  re-present these — the classifier drops them by design and that behaviour is correct.
- **The loss is 100% for the affected conversation, not a rate.** Per-hour figures are a property of
  **traffic**, not of the defect: 0.4/hour in a quiet stretch and 4/hour under load are the same
  defect. Do not size the work from an hourly number.

**A retraction worth keeping with it:** core had earlier stated this fires at compaction, and
retracted it after reading the deployed tree. An inference built on the first statement — that
compaction was silently re-presenting old identities — was made and withdrawn on this side within
the hour. **The premise was wrong, not just the conclusion.**

### 10.1 What is settled, and what still gates the ship

**Settled** — the five invariants (accepted unamended except I-2's five-component amendment and
I-5's no-retroactive-repair consequence), the A7 ruling, the rejection taxonomy, the account-field
question, the fence design, and the verification surface.

**Still gating, and none of it is plugin work:**

| Gate | Owner | State |
|---|---|---|
| Epoch-start column (`lifecycle_epoch_started_at`) | core@vc | **CLOSED** — shipped, deployed, verified against a real Postgres. Both fences live: declined at write when `observed_at` predates the epoch start, and required to match the conversation's *current* epoch at read. **My ship gate is down.** |
| Does a late id beat turn *N* or *N+k*'s extraction? | core@vc | **CLOSED — confirmed, and I was conservative.** The guard runs at **compaction**, not ingest, so the id must beat the compaction pass covering the reply turn: later still than *N+k*'s ingest. Deferred path is sufficient for the ordinary case. |
| Does the ingest handler accept an unknown top-level field? | cloud@vc | **CLOSED — verified in the deployed handler.** See below. |
| Exact-completion payload can carry ids outside the fingerprint | core@vc | **CLOSED — built** (`_vc_agent_outbound_ids`). Guild channels unblocked. |
| **Late-path endpoint** — path + status codes, **not under `/internal/`** | cloud@vc | **OPEN — the only remaining blocker for either half.** Asked twice by each of us. |
| **Nothing consumes the field yet** | cloud@vc | **OPEN.** It arrives, is ignored, and the ledger stays at 0 rows. |
| Where `_vc_agent_outbound_ids` sits on the payload | core@vc | open; a one-constant change either way |
| Ingest response echoing accepted ids | cloud@vc | optional; would retire the double-send |

### The unknown-field question, settled by reading the handler

`/api/v1/context/ingest` and the exact-source path are **the same handler** — both decorate
`rest_ingest`. That matters: the exact-source route carries guild channels and has the stricter
admission, so it could not be generalised to from the legacy route. It did not need to be.

`body = await request.json()` gives a plain dict; every field is read with `body.get(...)`.
Validation is **presence-based on named keys only** — reject-on-missing, never reject-on-extra. A
package-wide grep for `extra="forbid"`, `BaseModel`, `model_config`, unknown/unexpected-field
handling, `body.keys()` and allowlists returns two unrelated hits. **Nothing iterates the body's
keys.** An unrecognised top-level field is never read, cannot produce a 4xx, and cannot cost a turn.

**`carry` was armed on that basis — and, more importantly, in a way that TESTS it rather than
resting on it.** If the reading is wrong, `metadataRejected` climbs above 0 and the
retry-without-metadata path fires, visibly and with a count. Waiting would have left being wrong
invisible.

### 10.2 The coverage asymmetry — CLOSED for guild channels

This section previously recorded guild channels — the incident scope — at **0% coverage**, gated
behind the late path, gated behind the epoch column. **Both gates are gone.**

core@vc built `_vc_agent_outbound_ids`, a sibling key riding **outside** the fingerprinted region of
the exact-completion payload, and the plugin excludes that key from `completionOutboxFingerprint`.
So guild channels now carry ids on their own path and depend on nothing further.

**Why the exclusion is a correctness property, not tidiness:** `queueExactCompletion` dead-letters a
re-queue whose fingerprint differs, and its caller then returns **without queuing the completion at
all**. Identities are witnessed asynchronously, so the same source message can be queued twice with
different sets — covering them would have converted an ordinary retry into **a lost turn carrying a
real person's message**, the precise harm this feature exists to remove, introduced by its own fix.
Pinned by a test asserting present/absent/changed/empty fingerprint identically, **plus a positive
control** proving the fingerprint still covers everything else, since one covering nothing would
pass the first assertion too.

**Trust, stated because it would otherwise be inferred wrongly:** identities riding outside the
attested region are **not** covered by the attestation's integrity. That is not a regression — the
deferred path is equally unattested — but **a fast-path identity is exactly as trusted as a
late-path one, never more.** The protection is the namespace, the two epoch fences, and suppression
requiring an exact positive match.

---

### 10.3 The turn idempotency key — a cross-stack decision that lands on I-3

Not part of this feature, recorded here because **its resolution changes shipped code in this
package** and because the reasoning was settled by measurement on both sides.

#### 10.3.0 RETRACTED 2026-08-21 05:53Z — §10.3.1 below is WRONG, kept because the error is the lesson

**The claim in §10.3.1 that `runId` is structurally absent is REFUTED by the first production
numbers from the very instrument built to test it:**

```
turns=11  sessionId=11  rawRunId=11  group=1  groupNoRunId=0
```

**`ctx.runId` was present, raw and un-derived, on 11 of 11 turns, including the one group turn.**
The fallback described below never fired, because it fires only when `ctx.runId` is empty.

**How the error was made — two hooks, two context objects, one ruler:**

| Hook | Field | Measured |
|---|---|---|
| `message_sent` (outbound delivery) | `event.runId` | **0** — genuinely not plumbed |
| `agent_end` (turn path) | `ctx.runId` | **11 / 11 present** |

**Both are true. They are not the same field on the same object.** The outbound path has no run id;
the turn path does. Generalising the first to the second produced a *structural* claim from a
measurement of somewhere else — **the same checker/checked failure catalogued repeatedly in §9.6,
committed here, in the direction that discards a working option.**

**What the refutation does NOT establish, stated so nobody overcorrects:**

- **N = 11, and 9 are heartbeat turns** on one session and one lane. The population is nearly all
  cron, not member-facing.
- **The group population is N = 1.** `groupNoRunId=0` rests on a single Discord-channel turn, and
  **one observation is not a rate** — group transports were the specific case claimed to fail.
- **PRESENCE was counted, not DISTINCTNESS.** An idempotency key must differ per turn, and this
  counter cannot distinguish 11 present values from 11 copies of one value.

**The design conclusion is unchanged and never depended on the broken claim:** the sender-minted
UUID wins on availability and uniqueness *by construction*, not by comparison with `runId`.

> **The instrument refuted the claim of the person who built it, on its first reading.** That is the
> argument for building the second instrument, stated better than any reasoning could.

#### 10.3.1 `sessionId` + `runId` is not a candidate. It is structurally broken. — **RETRACTED, see 10.3.0**

Not "often missing" — *unusable by construction*:

```js
function hookInvocationRunId(ctx, sessionId = hookSessionIdentity(ctx)) {
  const runId = cleanInboundField(ctx?.runId);
  if (runId) return runId;
  return groupConversationSession(ctx?.sessionKey) ? "" : sessionId;   // <- THE PROBLEM
}
```

Group transports get `""`. Non-group transports get **the session id**, so the pair degenerates to
the session id alone and **collides on every turn of a conversation**. That is worse than a key
present 26.9% of the time, because a known gap is visible and this reads as a present, unique key
while being neither.

**The measurement that produced this is itself a correction.** "Session id present 152/152" came
from grepping `[vc] ingest — session=`, a line that only prints when there is a session id to
print — presence measured conditional on presence, true by construction. **Withdrawn.** §10.3.4 is
the replacement.

#### 10.3.2 The resolution: a sender-minted UUID, and why "same turn" is not circular

The sender mints a UUID at the point it decides to attempt a turn and reuses it on every retry of
that attempt. The objection raised here was that defining *"the same turn"* requires a per-turn
identifier, which is what is missing.

**It does not, and the distinction is the whole design.** The sender never has to *identify* a turn,
only *hold a value* across retries of one request:

> scope of reuse = the lifetime of the in-process retry loop for ONE request

**The boundary is not discovered, it is defined by where the value is created** — a local in the
attempt's scope. No lookup, no correlation, no per-turn state. Availability is 100% by construction,
which is precisely what receiver-minted and derived-from-existing-fields cannot offer.

#### 10.3.3 THE RULE THAT COLLIDES WITH THIS PACKAGE — and the carve-out that resolves it

Two receiver-side rules, both decided by measurement (1 content collision in 721 whole-turn
payloads — a 13s pair, both 200s, two genuinely distinct submissions):

| Case | Receiver behaviour | Why |
|---|---|---|
| New key, content matches an existing row | **Store it.** A new key means a new turn. | Identical content is not evidence of duplication; only the sender knows it is retrying. |
| **Same key, different content** | **Reject as an error.** Do not deduplicate. | A retry that mutated its payload is a defect; deduplicating it silently discards a corrected turn. |

**Row two breaks two things in this package.**

**(a) The clean fallback mutates its payload across a retry of the same request.**
`ingestWithOutboundIds` re-posts the same turn with the ids field stripped when the carrying POST
throws. Under a reused key that is *same key, different content* → rejected → **the turn is lost**.
The fallback's purpose is the opposite: shed the metadata to save the turn. The rule as written
inverts it, and we lose both.

> Worth stating both directions: the UUID **fixes** this fallback's shipped P0, where a post-commit
> network timeout makes the retry duplicate a committed turn. A key lets the receiver recognise the
> retry — **but only if the payload does not mutate**, which is exactly what the fallback does.

**(b) It contradicts I-3, which the receiver already accepted.**
I-3 makes the wire field an **additive idempotent set**. Identities are witnessed asynchronously on
`message_sent`, so two attempts at one turn can legitimately carry **different sets through no fault
of either side** — the later one simply witnessed more. That is the field working as specified, not
a mutated payload.

**THE FIX IS ALREADY SHIPPED HERE, WITH THIS EXACT REASONING.** `completionOutboxFingerprint`
excludes `_vc_agent_outbound_ids` from its covered region, and its own comment is the argument:

> *"Since identities are witnessed asynchronously, the same source message can be queued twice with
> different sets — so covering them would turn an ordinary retry into a lost turn. Excluded, the
> covered payload is byte-identical whether identities are present, absent, or changed."*

**"An ordinary retry into a lost turn" is case (a) verbatim.** The ask to the receiver is the same
carve-out on the content comparison. With it, a retry that drops ids and a retry that adds ids both
compare equal, and the rule keeps its teeth where they belong — an assistant reply that changed
between attempts.

Behaviour to pin down: key matches **and** covered content matches → **union the identity set**
(I-3), answer `duplicate` as success. Key matches, covered content differs → error.

#### 10.3.3a One narrowing on the stated scope limit

The receiver's scope limit reads *"a UUID cannot be recovered after losing in-process context, and
no design here can."* **True of the fast path; false of the exact-completion path**, which has a
durable store — `queueExactCompletion` persists the **whole payload verbatim** (fsync + rename), so
a UUID carried inside it is recovered on drain after a restart. The out-of-scope case is therefore
narrower: a restart mid-retry **on a path with no outbox record**.

Flagged because **this is the second time this store has falsified a claim** — v1 of
`SPEC-outbound-id-resend.md` §2 reasoned from one writer and concluded nothing reaches disk. Same
store, same shape of error. **Enumerate the stores.**

Also relevant to sizing: that outbox key is already
`sha256(deployment_id \0 conv_id \0 source_message_id)` — a durable idempotency key that exists
**today** — and it hard-requires `source_message_id`, i.e. the 26.9% population. **The UUID's real
job is the other 73.1%, where no durable key exists at all.**

#### 10.3.4 The second instrument — counters that can report an absence

Five counters in the `agent_end` handler, printed on the outbound-id report line:

```
turns=N sessionId=N rawRunId=N group=N groupNoRunId=N
```

`turns` increments on **every** `agent_end`, including turns carrying no identifier. That is the
only property that matters: it is what lets a zero here mean *absent* rather than *not looked at*,
which the grepped log line could never do.

`rawRunId` counts `ctx.runId` **verbatim, never the derived value**, because the derived value
substitutes the session id on non-group transports and would report per-turn availability that does
not exist. Pinned by a call-site regression test driving a real turn on a `direct:` key — where the
fallback would fire and be visible — because **a pure-function test cannot reach a call-site
substitution**. The mutation that swaps raw for derived survived the first pass and is now caught.

**STATUS: built, tested, NOT DEPLOYED. It has produced no numbers.** Production runs `6f9c4e2`;
between it and the instrument sits the ingest retry, which is ruled unbuilt in production and has
**no config gate** — three call sites invoke `postIngestWithLifecycleRetry` unconditionally — so any
deploy carrying the instrument also arms the retry. The prod tree was fast-forwarded before that was
checked, then reset to `6f9c4e2` with the gateway never restarted, so nothing was ever live.

> **"Unbuilt in production" is currently maintained by prod happening to be behind, not by any
> mechanism.** That is not a property, it is a coincidence with a deploy step pointed at it.
