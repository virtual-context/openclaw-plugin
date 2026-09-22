# DEFECT: the awaited outbox drain can consume the turn path's entire budget

**Status:** LIVE IN SHIPPED CODE. Not introduced by any work in flight. **Never observed to fire.**
**Owner:** openclaw@vc. Filed separately from `SPEC-delivery-time-identity-merge.md` because it
predates that design and **must not be discoverable only by reading a document about a different
subject.**

---

## 1. The defect

The run-bound group finalizer **awaits** the completion-outbox drain on the turn path:

```js
releaseExactGroupInvocation(sessionId, runId);
await scheduleCompletionOutboxDrain({ baseUrl, vcKey: ..., log, debug });
```

**That drain is not one request. It is a serial loop over due records:**

```js
while (processed < COMPLETION_OUTBOX_DRAIN_LIMIT) {   // 32
  ...
  for (const record of dueHeads) {
    processed += 1;
    await deliverCompletionOutboxRecord(record, worker.options);   // serial
```

and each delivery carries **two** independent timeouts:

| | |
|---|---|
| `requireExactSourceCapability` | `timeoutMs = 5000` |
| `vcPost(EXACT_SOURCE_INGEST_PATH, …)` | `15000` |
| **per record, one attempt** | **up to 20s** |
| `COMPLETION_OUTBOX_DRAIN_LIMIT` | **32** |

**So a single awaited drain has a worst case of 32 × 20s = 640s of turn-path time, against a
finalizer that fires at 30s.**

### 1.1 And a turn can be blocked on a conversation that is not its own

```js
if (worker.promise) return worker.promise;
```

**A turn arriving while a drain is in flight awaits THAT drain**, which is delivering whatever heads
were due — including other conversations' backlogs. **A healthy conversation can therefore be held
by an unhealthy one.**

---

## 2. Why it matters — the failure is a FALSE REPORT, not a delay

The 30s finalizer logs `ingest SKIPPED` and releases state in a `finally`. **So an overrun does not
merely delay a turn: the instrument reports a loss while the write is still in flight.** A turn that
ultimately succeeded is recorded as dropped, and any count built on that line inherits the error.

**That is the same class as everything else catalogued tonight** — a signal that is honest, is
correct about what it measures, and means something other than what it is read to mean.

---

## 3. Measured exposure — it has never fired, and the margin is smaller than assumed

```
agent_end -> post_end (TOTAL)   min 1.958s   median 3.664s   max 5.505s     n=20
```

**Worst observed is 5.505s against 30s.** The exposure is real but has never been approached,
because the receiver has been fast and the outbox has been effectively empty (0–1 due records).

> **The correction that matters: the finalizer budget is NOT comfortable.** A single slow delivery
> consumes 20s of 30s. It was being reasoned about as ~24.5s of headroom; **the true headroom
> against one stalled request is 10s, and against a backlog it is negative.**

**No deliberate wait is required to trigger this.** A slow receiver is sufficient, and a receiver
slow enough to hit a 15s timeout is an ordinary incident rather than an exotic one.

---

## 4. The fix, and its justification is independent of the feature that found it

**Do not await this turn's delivery. Apply backpressure to the outbox DEPTH instead** — option D of
`SPEC-delivery-time-identity-merge.md` §3.1.

The `await` exists so the turn path notices when delivery is unhealthy. **A growing backlog answers
that question directly**, and answers it without putting a turn's own delivery — or worse, another
conversation's — on the critical path.

> **This fix stands on its own.** It was found while pricing a design for carrying identities, and
> it would be correct if that design were abandoned tomorrow. **A fix whose justification does not
> depend on the problem that prompted it is a better fix.**

**Interim mitigations, if D is not built promptly:** bound the awaited drain (option C) so the turn
path escapes after a ceiling while delivery continues in the background; or lower
`COMPLETION_OUTBOX_DRAIN_LIMIT` for the awaited path specifically, leaving the background path free
to drain deeply.

---

## 5. What is NOT claimed

- **Not observed.** No turn has been recorded overrunning the finalizer through this path. This is
  exposure derived from constants and code, not an incident.
- **Not new.** It predates every change made tonight and is unrelated to the outbound-identity work
  except that pricing that work is what surfaced it.
- **Not the legacy path.** That POST is synchronous inside `agent_end` with its own timeout and is a
  separate question.
