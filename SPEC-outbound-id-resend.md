# Spec: re-presenting declined outbound identities

**Status:** DRAFT v2 — **spec only, nothing built.** v1 was reviewed and its central premise
(§2) was **false**; see §2.0 for the correction and §2.1 for the preserved error. Companion to
`SPEC-outbound-message-id.md`; that document's five invariants (I-1..I-5) govern here unchanged.
**Owner:** openclaw@vc, because the engine has no mechanism to re-offer and only the sender can.

---

## 1. Why this exists

**The engine never re-presents anything.** `record_bot_outbound_messages` is reachable from exactly
two call sites — `engine.py:2197` and `proxy/state.py:3573` — **both on the live turn path**. A
`git grep outbound` across `compaction_pipeline.py` and `compactor.py` returns nothing. There is no
sweep, no repair, no backfill, no replay.

**So an identity declined once is declined permanently unless the SENDER offers it again.**

Sealing the epoch boundary makes every *future* offer acceptable and **recovers nothing already
declined.** Those are two separate pieces of work and this is the second one.

---

## 2. Q1 — What is re-presentable? **Nothing today — but the reasoning below was wrong once already.**

**v1 of this section claimed nothing is ever written to disk. That was false**, and the correction
matters more than the conclusion it did not change.

### 2.0 ENUMERATE THE STORES. DO NOT REASON FROM ONE.

There are **five** places an identity can exist, not one:

| Store | Written by | Holds an identity? | Measured on prod 2026-08-21 03:2xZ |
|---|---|---|---|
| Pending set (memory) | every witnessed id | yes, 15-min TTL | not inspectable from outside the process |
| Outbound-id queue (disk) | `captureOutboundIdDurably`, **only when `latePath` is set** | yes | **directory ABSENT** — never written |
| **Completion outbox (disk)** | `queueExactCompletion`, **which persists the WHOLE payload** including `_vc_agent_outbound_ids` | **YES** | **0 records** — directory exists, empty |
| **Completion dead-letter (disk)** | `deadLetterCompletion` preserves the full record | **YES** | **directory ABSENT** |
| cloud capture ring | the receiver, pre-parse | yes | ~3.1 days, volume-driven, perishable |

**The completion outbox and its dead-letter were missed in v1.** Exact completions attach the ids to
the payload, and `queueExactCompletion` writes that payload verbatim — so identities **are** written
to disk on that path, `latePath` or not. They are unlinked on successful delivery, which is why the
store is empty rather than never-used.

**The conclusion survives; the reasoning did not.** Measured just now: **0 identity-bearing records
across every disk store.** So today there is still nothing to re-present from this side — **but that
is a measurement, not a property**, and it would have been wrong on any night where an exact
completion was retrying or dead-lettered.

> **REQUIREMENT: a dry run MUST scan all five stores and report counts BY SOURCE.** It may never
> conclude "unrecoverable" from a single store, which is precisely the error v1 made.

### 2.1 The v1 reasoning — WRONG, preserved because the error is the lesson

> **Everything in this subsection is the superseded argument. Do not cite it.** It is kept because
> a spec that quietly deletes its own mistake teaches nothing, and because the shape of this one
> recurs: **one store was inspected and a conclusion was drawn about all stores.**

```js
function captureOutboundIdDurably(convId, identity, sessionKey, observedAt) {
  if (!outboundIdCfg.carry) return;
  if (!outboundIdCfg.latePath) { outboundIdStats.unbackedFast += 1; return; }   // <- prod today
  ...
}
```

*(v1, wrong):* "`latePath` is unset in production, so **nothing has ever been written to disk**.
The durable queue exists and has never held a record. The only store is the in-memory pending set,
bounded by a 15-minute TTL. Therefore every identity declined tonight is gone from this side —
never persisted at all."

**Where it fails:** `captureOutboundIdDurably` is not the only writer. `queueExactCompletion`
persists the **entire** completion payload, and on the exact-source path that payload carries
`_vc_agent_outbound_ids`. So identities reach disk on a path this reasoning never looked at, and
`OUTBOUND_ID_PENDING_TTL_MS` is not the binding constraint it was claimed to be.

**The conclusion happened to survive because the outbox is empty tonight.** It would not have
survived a night with a retrying or dead-lettered completion, and nothing in the v1 argument would
have revealed that.

### 2.2 The one surviving record when the disk stores are empty, and it is perishable

**cloud's request-capture ring holds the full request bodies**, including the
`_vc_agent_outbound_ids` arrays, at
`/data/tenants/diagnostics/http-captures/*.json.gz` — raw pre-parse bodies with a `sha256`.

**It is not this plugin's store and it expires: ~3.1 days, volume-driven** (a 2,500-file cap binds,
not the configured 7 days, and captures compete with all fleet traffic).

> **Any recovery of already-declined identities must read that ring, and must happen before it
> rolls.** After that the identities are unrecoverable from any system.

**This is a decision with a deadline attached, and the deadline is not ours to extend.**

### 2.3 What WOULD be re-presentable once `latePath` is armed

Records in the durable queue, bounded by `OUTBOUND_ID_MAX_AGE_MS` (**30 min**) and 512 records per
deployment. **That bound was chosen when the queue was the only fence against a stale identity
crossing a delete-and-recreate.** With the engine's epoch fence now live at both write and read, the
30-minute bound is **no longer load-bearing for safety** and is the first thing to revisit — a resend
path is useless if its source expires in half an hour.

---

## 3. Q2 — What triggers a resend? **An explicit command. Not traffic, not the seal.**

**The engine will not ask.** `epoch_start_unknown` is a *permanent* decline in the taxonomy; the
classifier drops such records by design and that behaviour is correct. **Nothing downstream will
ever request a retry**, so the trigger must originate here.

Three candidates, and only one survives:

| Trigger | Verdict |
|---|---|
| **Automatically, when the seal lands** | **NO.** This is precisely the shape core@vc built and then backed out: a production data change firing on whatever traffic arrives first, with nobody deciding it. *"It was not staged, it was armed."* |
| **A periodic sweep** | **NO.** Same objection, plus it would re-present continuously against a receiver that may still be declining, turning one bounded action into an unbounded one. |
| **An explicit admin command, dry-run by default** | **YES.** Matches core's choice for the epoch backfill, for the same reason, and the two are ordered: **seal first, then resend** — resending before the boundary exists just reproduces `epoch_start_unknown`. |

**Ordering is a hard requirement, not a preference.** A resend run before the seal lands is
guaranteed to fail for exactly the reason that made the resend necessary.

**But sealing is NOT the first step — preserving the sources is.** Two of them are destructive on
their own schedule and neither waits for a decision:

1. **Snapshot every recovery source** (§2.0), including the cloud capture ring, which rolls in ~3.1
   days and is volume-driven.
2. **Freeze automatic drains against the snapshotted sources.** The outbound-id worker **deletes**
   a record on a permanent decline, and `epoch_start_unknown` is permanent — so an armed drain
   would consume exactly the records a resend needs.
3. Verify the endpoint contract (§3.1).
4. Seal the epoch boundary.
5. Dry run, reporting counts **by source** with denominators.
6. Execute.

**Steps 1 and 2 are time-critical and the rest are not.** Sealing first and preserving later can
lose the thing being recovered.

### 3.0a ANSWERED, AND THEN FORECLOSED — the recorder is standalone-callable; the seal refuses the history

**Q4 of §6 is answered: a sender-initiated offer IS implementable.** The receiver's
`record_bot_outbound_messages(tenant_id, agent_scope_id, conversation_id, observed, ...)` takes
plain arguments — **no request object, no session, no engine, no proxy, no payload.** The turn-path
dependency lives entirely in its two *callers*, not in the store method, so a new receiver surface
would call the existing recorder directly. **No engine redesign.**

**And then the seal forecloses the thing the answer unblocks.**

```python
cutoff = epoch_started_at - timedelta(seconds=max(0, int(clock_skew_seconds)))
```

The guild conversation's `epoch_started_at` is now the **sealed** boundary `03:41:19.317745Z`, so
the cutoff is `03:36:19.317745Z`. **Every historical identity recoverable from Discord has
`observed_at` before that, so all of them return `fence_rejection`.**

> **A sweep would recover the complete set and the receiver would refuse every single one.**

The seal's own comment described this as a narrow window — *"identities observed between the real
recreate and this seal are lost"* — but **the practical scope is the entire history**, because the
seal stamped `NOW` on a conversation whose real boundary was unrecoverable.

**So §3's ordering needs a step inserted in the middle:**

    route  ->  FENCE POLICY  ->  sweep

**And the middle step is a real decision, not a formality.** The fence exists to stop identities
from a deleted incarnation being admitted, which is the failure that costs a person's words. There
is a lever — `clock_skew_seconds` is a parameter rather than a constant, and a conversation could
carry a `derived` boundary instead of a `sealed` one — but **both deliberately weaken the guard, and
neither may happen as a side effect of building a route.** core@vc owns that call.

**Note what this does NOT affect:** identities offered *going forward* carry an `observed_at` after
the cutoff and pass the fence normally. **The foreclosure is historical only.**

### 3.1 The blocker that makes all of this theoretical today

**A sender-initiated resend does not ride a turn — and there is no endpoint that accepts one.**

The engine's two call sites are both on the live turn path. The late-delivery REST path has still
never been published. **So a resend has nowhere to POST**, and this spec cannot be implemented until
that route exists — the same blocker that has gated the late path since the beginning.

**Stated plainly so nobody builds the sender half against a receiver that cannot hear it.**

---

## 4. Q3 — Does idempotency still hold when the sender initiates? **Yes, and it is the reason this is cheap.**

I-3 makes the wire field an **additive idempotent set**: union on receipt, re-sending a known
identity is a no-op rather than an error or a duplicate row. **Nothing in that property depends on
what triggered the send** — it is a property of the receiver's write, not of the caller.

Confirmed against the receiver's own vocabulary: `duplicate` is an explicit **success** outcome
alongside `accepted`, so a resend of something already recorded is answered correctly rather than
counted as a failure.

**CONDITIONAL, and the condition is not yet met.** Idempotency is proven for the receiver's
**live-turn write path** and nowhere else. A sender-initiated route must independently demonstrate:
tenant and scope resolution outside a turn, `duplicate` returned as success, **no extraction or
compaction side effects**, and outcome counts scoped to the offered set. **Until that route exists
and is tested, §4 is an expectation rather than a property.**

**Consequences worth naming, subject to that condition:**
- **A resend costs nothing when it is unnecessary.** There is no need to determine what was already
  accepted before resending — the safe action is to resend and let the receiver deduplicate.
- **So the dry-run should report what it WOULD send, not what it thinks is missing.** Computing
  "missing" requires per-identity outcomes, which Tier 1 deliberately does not provide, and guessing
  it would reintroduce exactly the completeness inference I-1 forbids.
- **Order does not matter** (I-5): identities may arrive out of order, late, and more than once.

---

## 5. What this spec does NOT do

- **It does not widen the acknowledgement contract.** Tier 1 counts remain the ask. Per-identity
  outcomes would make a resend more precise and are **not needed** — see §4.
- **It does not propose a retry loop.** `epoch_start_unknown` is permanent and must stay permanent;
  a resend is an *operator action*, not an automatic retry, and the distinction is what keeps a
  permanent decline meaningful.
- **It does not assume tonight's identities are recoverable.** §2 establishes they are gone from
  this side and survive only in a ring that expires.

---

## 6. Open, and each needs an owner

| # | Question | Owner |
|---|---|---|
| 1 | **The late-path REST route** — still unpublished; without it nothing here is buildable | cloud@vc |
| 2 | Should `OUTBOUND_ID_MAX_AGE_MS` (30 min) be raised now the epoch fence carries the safety it was covering? | this side, with core@vc |
| 3 | Is recovering tonight's identities from the capture ring **worth doing at all**, given it must happen before the ring rolls? | the user |
| 4 | ~~Does the receiver accept an offer outside a live turn?~~ **ANSWERED: yes, the recorder is standalone-callable — see §3.0a.** | core@vc |
| 5 | **Fence policy for a historical sweep** — every pre-cutoff identity is refused today. Weakening the guard is a deliberate decision, never a side effect. | core@vc |

**Question 4 is answered: implementable. Question 5 now decides whether it is USEFUL** — a route that recovers everything and is refused everything is not a recovery path.
