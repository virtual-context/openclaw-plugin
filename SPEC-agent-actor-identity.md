# Spec: supplying the agent's own platform actor id

**Status:** DRAFT v1 — **spec only, nothing built.** **Owner:** openclaw@vc (the sender half).
The comparison that consumes it is core@vc's.

---

## 0. Why one value matters this much

The receiver's guard asks *"is this quoted text agent-authored?"* of a ledger that is empty, gets
*unknown*, falls through — and **two lines later builds a subject lane stamped with
`reply_subject_actor_id`, which for an agent-authored quote IS the agent's own id.** The answer is
already on the row. **Nothing compares it against the agent's identity because the engine does not
know its own identity.**

**So this closes the ghost without recovering a single historical identity, without a sweep, and
without touching `clock_skew_seconds`** — which is far better than deliberately weakening a fence
that exists to stop a deleted incarnation being admitted.

---

## 1. THE ASYMMETRY THAT DESIGNS THIS — a wrong id deletes a person's words

**The two failure modes are not comparable and the design must not treat them as such:**

| | Effect |
|---|---|
| **Too narrow** — configured id never matches the real one | The guard never fires. **The ghost persists. This is today's state:** bad, visible, no worse than now. |
| **Too broad** — configured id matches something that is not the agent | **The guard fires on a real person's quoted words and suppresses them.** |

**The second destroys a member's disclosure and leaves no trace that it existed.** It is the same
class as admitting a deleted incarnation — *the failure that costs a person's words* — arriving
through the fix rather than through the fence.

> **Every verification decision below resolves toward "too narrow." A disagreement must degrade to
> today's behaviour, never to a broader match.**

---

## 2. Where the value lives, and the source that is REJECTED

| Source | Verdict |
|---|---|
| `[discord] client initialized as <id>` at startup | **REJECTED.** Ground truth, and recovering it means pattern-matching a string another component formats — right until someone changes a log format, then **silently** wrong. Same fragility being retired elsewhere in this package. |
| `plugins.entries.discord-link-curator.config.botUserId` | Corroboration only (§4) |
| `plugins.entries.bts-relay.config.botUserId` | Corroboration only (§4) |
| Hook context | **Does not exist.** No self/bot id in any hook context type; the runtime's `selfUserId` is private. **Not derivable.** |
| `openclaw.sqlite` | **Zero hits, every column of every table.** |

**Because it is not derivable, it must be configured. Because it is configured, it must be
verified.**

---

## 2a. ANSWERED — THIS PLUGIN IS NOT ON THE DELIVERY PATH

**Settled with core@vc 2026-08-21. The value does not travel. There is no endpoint and this package
sends nothing.**

**Why there is no endpoint, which is not the same as core declining to name one:**
`context/capabilities`, `context/ingest` and `context/prepare` are **cloud's routes, not the
engine's** — `context/capabilities` does not appear in the engine repository at all. **The engine has
no HTTP surface to add one to.** And a capabilities-style handshake would be scoped to a live
connection, **reintroducing the forward-only defect this fix exists to remove**: the guard runs at
**compaction**, over rows ingested months earlier, and a per-offer value has no offer to ride for a
row from July.

**The engine reads its own configuration at construction**, once per new conversation in the proxy
registry, which is readable at compaction time for any row. **cloud@vc sets one value. This plugin
changes no transport.**

```yaml
agent_actor_ids:            # engine config, NOT this plugin's wire
  discord: "1485681229608259666"
```

### 2a.1 SEND THE BARE ID. NEVER THE ASSEMBLED STRING.

The receiver assembles `actor:{platform}:{id}` itself with `_normalize_actor_id(platform, user_id)`
— **the same function the ingest path uses to build `reply_subject_actor_id`, which is the value
being compared against.** One derivation on both sides, so the comparison cannot drift from the
thing it compares to. **This is the property that made `account_id` correct by construction rather
than by luck.**

> **IT FAILS SILENTLY.** If either side ever pre-assembles that string, **the comparison still
> works, still passes its tests, and the cannot-drift property is gone with no symptom until a
> format changes.** A property that fails invisibly needs a comment at both ends rather than a
> shared understanding — and the tempting future change originates *here*: *"we already have the
> platform and the id, let us just send the assembled string."*

### 2a.2 What remains on this side, and what it is NOT

**The config, the corroboration and the tripwire stay as a LOCAL guard on a LOCAL value. They are
not part of the fix and must not be described as such.**

**Every `[vc:actor-id]` boot line must state that the value is not delivered anywhere.** Without
that, a reader who configures `agentActorIds` — reasonably, having read the schema — gets a line
asserting a *verified agent identity* over a value nothing reads. **A green check over a value with
no consumer is worse than no check, because it is indistinguishable from a working one.**

### 2a.3 The receiver's cross-check SUPERSEDES the tripwire, and by a wide margin

| | Coverage | Timing |
|---|---|---|
| **This side's tripwire** | fires only if the misconfigured id happens to speak | whenever that happens, or never |
| **The receiver's check** | **every stored row the compaction holds — 4,645 fleet-wide** | **before anything is suppressed** |

Measured there: **the bot appears as an inbound sender in 0 of 4,645 rows, while 15 real people
appear in both roles.** **That is the stronger form of the same check, and it sits on the value the
guard actually reads.**

> **A hand-entry validated against two other hand-entries is not validation.** *A majority of
> hand-entries is still hand-entries* — and that applies to agreement, and to this side's own check,
> exactly as it applies to a majority. **This side cannot read the platform identity at all**
> (no self/bot id in any hook context type; the runtime's `selfUserId` is private), so routing the
> value through here would validate a transcription against transcriptions.

## 3. Shape

```json
"agentActorIds": { "discord": "1485681229608259666" }
```

**Keyed by platform, never a bare string.** Telegram is already an uncovered population in this
feature; a bare string is wrong the day a second platform matters and **silently wrong before that.**

**On the wire it rides beside `agent_scope_id` inside `_vc_agent_outbound_ids`** — same field, same
path, no new route. That is what makes this cheap.

**Logged at boot**, so the running process states the identity it will send rather than leaving it
inferred from a file someone may have edited since.

---

## 4. VERIFICATION — three checks, and disagreement is FATAL

### 4.1 Corroboration against the existing hand-entries

Both other plugins carry `botUserId`. The VC plugin already loads `openclaw.json` and can read them.

- **All present and equal → proceed.**
- **Any present and unequal → REFUSE TO ENABLE THE COMPARISON.** Not a warning. **A typo shared
  between a config file and a suppression rule is what deletes a member's words**, and the boot
  cross-check is the only thing standing between those two.
- **None present → proceed, logged as `UNCORROBORATED`.** **Absence is not agreement.** Refusing
  here would make the feature unbuildable on any host without those two plugins, which is a
  different defect; but an uncorroborated id must say so in its own boot line rather than looking
  identical to a verified one.

### 4.2 The inbound tripwire — an INDEPENDENT check, not a second copy of the first

§4.1 protects against a typo. **It does not protect against a value that is systematically wrong and
copied three times** — which is precisely the "too broad" case.

**The plugin already computes the comparison string for inbound traffic:**

```js
put("sender_actor_id", `actor:${platform}:${senderId}`);
```

> **If the configured agent actor id is ever observed as an INBOUND sender, it is not the agent.**
> Disable the comparison, log loudly, and keep today's behaviour.

**This is a genuinely independent instrument** — it is derived from live traffic rather than from
another hand-entered config value, so it can catch what §4.1 structurally cannot.

**Its limits, stated:** it is a tripwire, not a proof. It fires only if the misconfigured id happens
to speak, so **silence from it is not corroboration** and must never be reported as such.

### 4.3 What is deliberately NOT done

**No inference from frequency.** *"The actor id on 88% of reply-bearing rows must be the bot"* is a
distribution answering a question about identity — **the exact reach retracted repeatedly in this
campaign.** A value that is knowable must be known, not inferred. core@vc refused this and the
refusal is correct.

---

## 5. Degraded mode

**Every failure path lands on today's behaviour: the comparison is disabled, ghosts persist, nothing
is suppressed.**

> The cost of not firing is a ghost row that already exists. The cost of firing wrongly is a
> person's words. **Those are not comparable, so the degraded mode is not a judgement call.**

---

## 6. The drift property — this spec installs one, on purpose, and buys it back

`account_id` is correct today because it comes from **one derivation shared by writer and guard**, so
it cannot drift. **A hand-entered id in a third config location has precisely the opposite
property:** if the bot is recreated, three places must change and nothing detects disagreement.

**§4.1 is what buys that back, which is why it is fatal rather than advisory.**

**The durable fix is not in this package:** an SDK surface exposing the bound account's platform
identity would make the value derivable and end the drift risk. **Off this critical path, raised
separately with whoever owns the host.**

---

## 7. Open

| # | Question | Owner |
|---|---|---|
| 1 | ~~Per-offer or tenant configuration?~~ **ANSWERED: neither — engine configuration, set by cloud. This package sends nothing. See §2a.** | core@vc |
| 2 | ~~What does the receiver do when the id is absent?~~ **ANSWERED: an explicit third outcome.** `QUOTE_IDENTITY_UNKNOWN` — unevaluable, does **not** suppress, and is **counted**. Logged on every compaction run **including when every count is zero**, because a guard that never ran and one that ran and matched nothing are otherwise identical in the record. | core@vc |
| 3 | SDK surface for the bound account's platform identity | host owner |
