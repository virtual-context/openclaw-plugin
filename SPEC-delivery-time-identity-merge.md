# Spec: carrying an identity on its OWN turn

**Status:** DRAFT v1 — **spec only, nothing built.** Companion to `SPEC-outbound-message-id.md`;
I-1..I-5 govern unchanged. **Owner:** openclaw@vc.

---

## 1. The defect is CAUSAL, not a race

Discord assigns a message id **on send**. The send happens after `agent_end` completes. **So the
identity cannot exist at its own turn's ingest — not usually, not 99% of the time, by construction.**

Every identity therefore rides the **next** ingest for its conversation. Confirmed by two
independent instruments that could not see each other's evidence: the host's hook-dispatch log on
this side, and raw captured request bodies on the receiver's — the id produced at 05:53 was carried
by the 06:00 ingest, seven minutes and one whole turn later.

**Consequence: the agent's last message before a conversation goes quiet is never represented.**
There is no next ingest to carry it. The ledger converges on *"every agent message except the most
recent one in each conversation"* — **a systematic hole, not a sampling gap** — and a final message
is an entirely ordinary thing to quote-reply to hours later, which is the defect this feature exists
to close. `unbackedFast` counts exactly these, and reads 3 of 3 since the restart.

**This closes exit criterion #5 of `RUNBOOK-phase-a-observe.md`**, which deliberately refused to
guess it. **Answer: the fast path carries the previous turn's id and never its own.**

### 1.3 OBSERVED COMPLETING, 2026-08-21 — two identities lost, live, both sides instrumented

**Not inferred from a flat total. Watched.**

```
18:30:35  events=1  witnessed=1  carriedExact=0  evictedPending=0
18:37:56  events=2  witnessed=2  carriedExact=0  evictedPending=0
19:56:21  events=3  witnessed=2  carriedExact=0  evictedPending=0   refused[telegram=1]
19:58:31  events=4  witnessed=2  carriedExact=0  evictedPending=0   refused[telegram=2]
20:0x     events=5  witnessed=2  carriedExact=0  evictedPending=2   <- both swept, never carried
```

Affected conversations: `…discord:channel:1529892355141013684` and
`…discord:channel:1524917968440524990`.

**And it corrected the mental model on the way.** Both identities sat **90 minutes** against a
**15-minute** TTL without being evicted, because **pruning is write-triggered — nothing sweeps on a
clock.**

> **They were not on a countdown. They were in a race with no deadline:** an ingest in their **own**
> conversation carries them; **any** witnessed outbound **anywhere** evicts them. **The eviction is
> non-local — an unrelated conversation ended these two.**

**The losing branch was taken.** A fifth outbound event elsewhere triggered the prune and swept both.

**One honest limit:** `evictedPending` is a global counter and does not name which entries it
dropped. That these are the same two follows from `witnessed=2`, `carriedExact=0` and no other
identity entering the set since the restart — **an inference, not a measurement.**

**This is the first confirmed instance of exactly what §3's trigger-plus-fallback design prevents.**

### 1.4 OPERATIONAL — every restart has a non-zero identity cost until §3 lands

**A gateway restart discards the in-memory pending set.** That was a footnote until it was measured:
**one of the three losses in §1.3 was caused by a restart performed for a deploy**, 21 seconds after
the identity was witnessed.

**Five restarts were performed on 2026-08-21** — freeze lift, gate deploy, audit install, audit arm,
falsifier fix — **and each silently discarded whatever was pending at that instant.** None was
weighed against that cost, because the cost was not known.

> **A text-only change to a log message is not worth a lost identity.** Until the trigger-plus-
> fallback design in §3 lands, **deploys should be BATCHED**, and a deploy carrying only an
> instrument improvement should wait for one that must ship anyway.

**How to price it before deploying** — read the current report:

```
witnessed - carriedExact  ≈  identities pending right now
```

**If that difference is non-zero, a restart destroys that many.** It is an approximation — the
counters are cumulative and a carried identity is not released, so the difference overstates in a
busy conversation and is exact in a quiet one — **but it is a number, and it is available before the
decision rather than after.**

---

## 2. THE MEASUREMENT — n=20 turns, millisecond resolution

Required by the lead before any design, because *"short"* is not a bound and reasoning is not a
measurement. Source: `journalctl -o cat`, parsing the ISO-with-ms prefix, over every turn since
2026-08-20 16:03Z that emitted all four events.

```
MARGIN = post_start - message_sent   (POSITIVE = the POST began AFTER the id existed)
  min -3.083s   median -0.599s   max -0.403s
  turns where the POST started AFTER message_sent:  0 of 20

  agent_end -> post_start          min 0.099  median 0.124  max 0.327
  agent_end -> message_sent        min 0.502  median 0.746  max 3.207
  post_start -> post_end           min 1.859  median 3.490  max 5.321
  agent_end -> post_end  (TOTAL)   min 1.958  median 3.664  max 5.505
```

### 2.1 What this kills

**A delivery-time merge ALONE captures 0 of 20.** The drain fires ~0.12s after `agent_end`; the
identity lands ~0.75s after. **It is not close and it is not marginal — merging at the existing
delivery moment would have carried nothing, ever.** Any design that only moves *where* the field is
populated, without moving *when* delivery happens, is a no-op.

### 2.2 The constraint that makes a WAIT expensive

```js
releaseExactGroupInvocation(sessionId, runId);
await scheduleCompletionOutboxDrain({ baseUrl, vcKey: ..., log, debug });
```

**The drain is AWAITED on the turn path.** So any deferral is added directly to the run-bound group
finalizer's budget. That finalizer fires at 30s, logs `ingest SKIPPED`, and releases state in a
`finally` — **so an overrun makes the instrument report a loss that did not happen while the write
is still in flight.** The lead's objection is specific and correct.

**Budget arithmetic, from the measurement rather than from feel:**

| | |
|---|---|
| worst observed total today | **5.505s** |
| headroom to the finalizer | **24.5s** |
| fixed wait needed to cover the observed max (3.207s) | ≥ 3.5s |
| worst total under a 3.5s fixed wait | ~9.0s, leaving ~21s |

**A fixed wait fits. It is still the wrong shape**, because 3.207s is an observed max over 20 turns
and not a bound — the tail is unmeasured, and a wait sized from a sample silently truncates it.

---

## 3. THE DESIGN: trigger, not wait

**Preferred, and the lead's instinct that a trigger beats a wait is supported by the numbers:**
firing on `message_sent` delivers at the **median 0.746s** instead of blocking a blind 3.5s, and it
covers the 3.207s tail automatically **because it is driven by the event rather than by a guess
about the event.**

```
agent_end   -> queue the record durably (unchanged), do NOT deliver yet
message_sent for that conversation -> merge pending identities, deliver
no message_sent within the fallback window -> deliver anyway
```

**The fallback is not optional.** Turns that produce no outbound message at all — `NO_REPLY`,
heartbeats, cron — must still deliver, and they are the *majority* of turns (9 of 11 in the
post-restart sample). **A trigger with no fallback silently strands every turn that never speaks.**

### 3.1 THE `await` — four options priced, and the trigger forces the question rather than leaving it open

**Framing correction first, because it changes the menu.** With a trigger, delivery happens *after*
`message_sent`, which happens *after* the `agent_end` hook returns. **So the turn path cannot await
this turn's delivery at all without waiting past the identity — which is the fixed-wait option §3
already rejected.** Adopting the trigger does not leave the `await` open; it removes it.

**That makes the real question narrower and better:** the `await` exists so the turn path notices
when delivery is unhealthy. **Is this turn's delivery the right thing to watch for that?**

| | Option | Compatible with the trigger? | Cost |
|---|---|---|---|
| **A** | Keep the `await` as-is | **No** — it would have to wait past `message_sent` | Delivery latency counts against the 30s finalizer. **And it already can overrun today:** a capability probe at `timeoutMs = 5000` plus a POST at `15000` is **up to 20s for ONE attempt**, before any retry. The overrun path exists now; the trigger did not create it. |
| **B** | Drop the `await` (`void`, as `drainAllCompletionOutboxes` already does) | Yes | **No backpressure at all.** A slow or failing receiver accumulates queued deliveries and nothing on the turn path notices. Bounded eventually by `COMPLETION_OUTBOX_MAX_ATTEMPTS = 4096` and `COMPLETION_OUTBOX_MAX_AGE_MS = 7 days` — **bounds that stop a leak, not bounds that report a problem.** |
| **C** | Bounded `await`, continue in background past the ceiling | **Only in the fixed-wait design** | Under a trigger there is nothing left to await. In the fixed-wait world it is strictly better than A: backpressure when cheap, escape when not, and the ceiling is a **safety bound rather than a timing guess**, so it does not inherit the tail problem that kills the fixed wait. |
| **D** | Drop the await on *this* delivery, and apply backpressure to the **outbox DEPTH** instead | Yes | Keeps the property the `await` was there for — the turn path notices unhealthy delivery — **without coupling it to the delivery that must not be waited for.** Reads the queue it already reads. |

**RECOMMENDATION: trigger + D.**

**The insight is that A and C are both watching the wrong thing.** Awaiting *this* turn's delivery
tests the receiver using the one request that must not be blocked on. **The backlog answers the same
question** — a receiver that is slow or failing produces a growing outbox — **and it answers it
without putting a turn's own delivery on the critical path.** A turn that finds the backlog over a
threshold can log, count, or fail fast, and none of that requires waiting on itself.

**It also closes the latent overrun in A**, which is worth stating separately because it is a defect
in the shipped code rather than a property of any proposal: **20s of timeout budget on the turn path
today, against a 30s finalizer, with retries on top.**

**C stays on the record as the right answer to a question we are choosing not to ask.** If the
trigger turns out to be unworkable and the fixed wait is the only route, C is what should be built,
not A.

### 3.1a The question this design turns on, and it is NOT a timing question

**Should the drain still be awaited on the turn path at all?**

The record is durable on disk *before* the await, and `releaseExactGroupInvocation` has already run,
so the turn's correctness does not depend on the await completing. **The codebase already contains
the non-awaited form** — `drainAllCompletionOutboxes` uses `void scheduleCompletionOutboxDrain(...)`.

**Ordering is NOT the obstacle.** The in-code justification for the await is that *"all exact
deliveries, including the first attempt, pass through one ordering worker"* — and the worker is the
serialization point regardless of who schedules it. **Dropping the await removes the turn path's
backpressure, not its ordering.**

**So the real decision is whether the turn path should keep applying backpressure to delivery.** That
is a design question with a real answer either way, and it should be decided explicitly rather than
inherited from an `await` that predates this problem.

### 3.2 What must be measured before build, not during

1. **The fallback window, from a distribution and not from this sample's max.** 20 turns is enough
   to kill the delivery-time-merge-alone option (0 of 20 is unambiguous). **It is not enough to size
   a timeout.**
2. **Whether removing the await changes observed finalizer behaviour**, with the negative control
   being a turn that produces no outbound message.
3. **Double-delivery safety on the trigger path.** The record is unlinked only on success, so at
   `message_sent` a record may be *in flight*. **A naive re-drain could deliver twice.** The ordering
   worker likely prevents it; *likely* is not a test.

---

## 4. SCOPE — bounded, and stated as bounded

**This closes the guild-channel population, which is the one the incident came from. It closes
nothing else.**

- **The legacy fast path gets NOTHING.** Its POST is synchronous inside `agent_end`, so there is
  nothing to defer without delaying the turn itself. Said plainly rather than left implied.
- **A record already delivered and unlinked before its identity arrives still needs the late path**,
  which has never been published.
- **Multi-chunk replies are unchanged** — the host emits only the last chunk's id.

---

## 5. THE CARVE-OUT IS NOW LOAD-BEARING TWICE — do not tidy it

`completionOutboxFingerprint` excludes `_vc_agent_outbound_ids` from the covered region. **It was
added so an additive, asynchronously-witnessed set could not turn an ordinary re-queue into a
dead-letter. It is now also what makes this entire design legal**, because populating the field
after the payload was fingerprinted is only safe while the field is outside the fingerprint.

**And the causal mechanism is the reason; the other two arguments were symptoms.** The receiver
traced it independently: re-sending the 05:53 turn after 06:00 would carry an id **that did not
exist when the turn was first sent** — same key, different content, an ordinary retry rejected and
the turn lost under their original rule 3.

> **A constraint added for one purpose turned out to license a capability nobody designed for.**
> Anyone tempted to simplify that exclusion must know it is now holding up two independent things.

---

## 6. Open

| # | Question | Owner |
|---|---|---|
| 1 | ~~Keep the backpressure or drop it?~~ **Four options priced in §3.1; recommendation is trigger + D — backpressure on outbox DEPTH, not on this turn's delivery.** Needs a threshold and an action. | this side, with the lead |
| 1a | **Latent, in shipped code:** 5s capability probe + 15s POST = up to 20s of turn-path budget per attempt against a 30s finalizer, before retries. Independent of everything proposed here. | this side |
| 2 | Fallback window, sized from a distribution rather than a max | this side |
| 3 | Does the ordering worker actually prevent a double delivery on a triggered re-drain? | this side |
| 4 | Anything already delivered before its id arrives — still blocked on the unpublished late-path route | cloud@vc |
