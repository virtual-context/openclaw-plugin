# Spec: retrying a retryable ingest failure

**Status:** v3 — reviewed; 1 P0, 2 P1, 3 P2 folded. — **BLOCKED, not merely unbuilt.** The retry described here is **unsafe to implement
today** and the blocker is on the receiver, not here. See §0.
**Owner:** openclaw@vc.

---

## 0. WHY THIS IS BLOCKED — read before anything else

> **The retry is unsafe until the receiver distinguishes pre-persistence from post-persistence
> failures, and the response body is currently incapable of that distinction.**

`conversation_lifecycle_busy` has **two causes with a byte-identical response body** — same `type`,
same `message`, same `retryable: true`:

| | Raised | Persisted? | Retry |
|---|---|---|---|
| **A** | `"tenant conversation construction busy"` — while resolving conversation state, **before** `persist_completed_turn` | **no** | **safe** |
| **B** | `"stale session checkpoint refused"` — via `save_session_state` in the passthrough branch, **after** `persist_completed_turn`, **unguarded** | **YES** | **DUPLICATES THE TURN** |

**B is live, not theoretical: 16 occurrences in 11 hours** on the receiver's side. Those arrived
through an eviction path rather than ingest, **but the ingest path contains the same unguarded
call**, so the hazard is real on the path this retry would run on.

**Retrying on the HTTP status is unsafe. Retrying on the error type is ALSO unsafe**, because both
causes carry the same type.

### 0.1 The available workaround is forbidden, and the reason matters

The two causes differ **only in the human-readable `message` string**. Distinguishing them by
matching that string is **the exact defect §3.1 of this spec exists to retire**: recovering a fact by
pattern-matching text another component formats. Two rulers for one fact, silently wrong the day
somebody edits the wording.

**Building the retry on a message regex would remove one instance of that defect and add a worse
one.** Do not do it.

### 0.2 The unblocking condition, stated as one sentence

**The receiver must emit a distinct error type for cause B.** Then `conversation_lifecycle_busy`
means only cause A, retry-on-named-type is safe **by construction rather than by probability**, and
it covers the only ingest failure of this kind anyone has observed.

---

## 0.3 THE HAZARD IS ALREADY ARMED IN SHIPPED CODE

**This is not only about the retry this spec proposes.** `ingestWithOutboundIds` **already** retries
the turn clean after any metadata-carrying ingest failure — shipped, deployed, and live under
`mode: carry`:

```js
} catch (error) {
  // ... retry the ORIGINAL payload
  return vcPost(baseUrl, path, vcKeyFor(sessionKey), convId, ingestPayload, 15000, log);
}
```

**If the metadata-bearing request COMMITS and the response is lost, the clean fallback commits a
second copy.** The turn is stored twice. That retry was added to satisfy I-4 — *metadata must never
cost a turn* — and it introduced a way for metadata to **damage** a turn instead.

**Measured: it has never fired.** `metadataRejected` has been **0** across every report since deploy,
so the fallback path has not executed once in production. **Armed and unrealised — a near miss of
exactly the same shape as the dropped cron turn.**

**It must not be treated as safe because it has not fired.** The unblocking condition in §0.2 covers
it too: with a no-mutation guarantee or an idempotency key, both this fallback and the proposed retry
become safe. Without one, **neither is.**

---

## 0.4 THE GATE — "unbuilt in production" is now enforced by code, not by a stale checkout

**Until this section, the retry was kept out of production by nothing except production being
several commits behind.** That is not a property. It is an accident of which commit happens to be
checked out, and it survives exactly until someone runs a routine fast-forward — which nearly
happened: a deploy step that read *"prod is behind, fast-forward it"* bundled the retry onto the
production tree. It was caught before the gateway restarted, so nothing ever ran, **but it was
caught by remembering a decision from a conversation, not by any check.**

**Conversations do not survive. The gate does.**

```js
export function normalizeIngestRetryConfig(raw) {
  return { enabled: raw?.enabled === true };
}
```

```js
async function postIngestWithLifecycleRetry(path, vcKey, convId, payload) {
  if (!ingestRetryCfg.enabled) {
    return vcPost(baseUrl, path, vcKey, convId, payload, 15000, log);
  }
  ...
```

Three deliberate choices:

- **An early return, so the retry loop is UNREACHABLE rather than bounded to one attempt.** A gate
  that merely sets the attempt count to zero can be re-armed by any later edit to the loop's
  conditions; an unreachable loop cannot.
- **Strict `=== true`.** A truthy string or `1` in a hand-edited config must not arm a retry path
  whose covered failure population is empty. Anything unrecognised defaults off.
- **The gated-off path still throws.** The clean fallback in `ingestWithOutboundIds` depends on the
  error reaching it; a gate that swallowed the failure would silently disable that too. Pinned by a
  test and by a mutation.

### 0.4.1 VERIFYING IT IS INERT ON THE RUNNING ARTIFACT — and the limit of that check

A boot line reports the gate from **the same variable the branch reads**:

```
[vc] ingest conversation_lifecycle_busy retry: OFF (default)
```

**That proves the normalizer's output inside the running process. It does NOT prove the branch
executed**, and the difference is not pedantry: with zero naturally-occurring failures, an inert
retry path and a live one that never fires produce identical logs. **A silent log is not evidence.**

**What can actually be verified, and is:**

1. **The deployed artifact is byte-identical to the tested commit** — `sha256sum index.js` on the
   host against the local file at that commit. This is what makes the test results transferable.
2. **An integration test drives a real `conversation_lifecycle_busy` 503 through
   register → agent_end with the config unset and asserts exactly ONE ingest call.** That is the
   discriminating check, and it exercises the branch rather than describing it.
3. **A positive control arms the gate and asserts two calls**, so `OFF` is a measured result rather
   than a build in which the retry was simply deleted.

4. **THE DEPLOYED ARTIFACT IS EXECUTED AGAINST A REAL FAILURE.** This was written off once as
   impossible — *"anything stronger would require injecting a failure into production"* — and that
   was too pessimistic. **There is a third option between reading config and touching live
   traffic:** run a probe on the production host that imports the deployed `index.js`, registers it
   with **production's own plugin config read from `openclaw.json`**, stubs `fetch` to return a real
   `conversation_lifecycle_busy` 503 with a `Retry-After`, and drives a turn through
   `before_prompt_build` → `agent_end`.

```
ingest POSTs        : 1
gate boot line      : retry: OFF (default)
retry log emitted   : false
RESULT: RETRY BRANCH DID NOT EXECUTE
```

**That is the branch executing, on the deployed bytes, with the deployment's own config.** No
production traffic, no network, no production state (temporary `HOME`), nothing written to the
tracked tree.

**What it is still NOT:** a measurement inside the gateway process. The supportable claim is *"the
deployed artifact does not execute the retry under this deployment's config"*, carried to the
running process by (1) `sha256sum index.js` matching on both sides and (2) the gateway having
loaded that file at boot. **Do not upgrade that to "the retry did not run in production."**

> **The general lesson, which outlives this gate:** *"can't verify without touching prod"* is
> usually a failure to look for the third option. **The deployed file is executable by something
> other than the deployment.**

---

## 1. The defect

```
2026-08-21T03:07:24Z  [vc] ingest failed: VC API 503:
  {"error":{"type":"conversation_lifecycle_busy",
            "message":"Conversation state is busy; retry the request.",
            "retryable":true}}
```

The receiver returned **`retryable: true`** and a **`Retry-After: 1`** header. The plugin logged the
error and dropped the turn.

```js
} catch (err) {
  log.error?.(`[vc] ingest failed: ${err}`);
}
```

**No retry, no queue, no backoff.** A transient, self-clearing condition is treated as terminal.

### 1.1 The real finding is the asymmetry, not the drop

**Turn durability is currently a property of which code path a turn happens to take**, and nobody
chose that:

| Path | On failure |
|---|---|
| Exact-admission (`queueExactCompletion`) | durable outbox, capped exponential backoff with jitter, 4096 attempts / 7-day budget, dead-letter |
| **Legacy `agent_end` ingest** | **`log.error` and drop** |

Same file, same class of failure, opposite outcomes.

---

## 2. What is NOT true, corrected before it sizes the work

**The turn dropped on 2026-08-21 was not member-facing.** Recovered from the receiver's capture ring:

```
user_message      "[cron:ea68c73e-… vast-nightly-ambient-participation] Run Vast's …"
assistant_message "NO_REPLY"        <- 8 characters
conversation_id   (empty)
```

**A scheduled ambient-participation run whose output was the agent declining to speak.** Nothing was
generated and nothing reached a member. **The vulnerability fired and cost nothing.**

**It is a near miss, and that is the argument for fixing it** — the next occurrence need not be so
cheap. But it changes the sizing, and two denominator corrections follow.

### 2.1 The denominator must be member-facing turns with content

**~8% of ingests in the receiver's ring (57 of 722) carry a `[cron:` prefix**, and some real turns
produce `NO_REPLY`. **A drop rate computed over all `agent_end` failures overstates member-facing
exposure by at least that much.** Any instrumentation added here must count **member-facing turns
that produced actual content**, and must exclude cron and `NO_REPLY` from the exposure figure —
while still counting them for path health.

### 2.2 Prepare failures and ingest failures are DIFFERENT HARMS and must never be lumped

| Failure | Harm |
|---|---|
| **ingest** fails | the turn is **not stored** — data lost |
| **prepare** fails | the turn is **answered without memory** — degraded answer, nothing lost |

The other recorded 503 (`2026-08-19T03:03:04`) was on **prepare**, for a real member asking for a
stack rating. **They answer to different owners and different fixes; instrumentation that reports one
number for both is measuring nothing.**

### 2.3 Rate — and the 503 is ONE of SEVEN dropped turns

Measured on the gateway journal, window **2026-08-14T03:19 → 2026-08-21**, ~7 days:

```
INGEST    OK 463   failed 7   SKIPPED 23     -> 7 of 470 attempts, ~1.5%
PREPARE   OK 970   failed 6                  -> different harm, counted apart (2.2)
```

**Six of the seven failures are TIMEOUTS, not the 503:**

```
08-16 03:05  TimeoutError        08-17 00:28  TimeoutError
08-16 22:48  TimeoutError        08-21 03:07  VC API 503 conversation_lifecycle_busy
08-16 23:01  TimeoutError        08-21 03:16  TimeoutError
08-16 23:12  TimeoutError
```

### 2.3a TWO OF THE SEVEN WERE SELF-INFLICTED — and they are the only 503

One of our own diagnostics pegged a production core for 25 minutes on 2026-08-21; two prepares that
had hung for **23 and 12 minutes** completed within **15 seconds** of it being killed. **Both Aug 21
failures fall inside that window.**

```
5  TimeoutError   Aug 16-17   natural
1  503 THIS TYPE  Aug 21      SELF-INFLICTED
1  TimeoutError   Aug 21      SELF-INFLICTED
```

**Deduplicated and split by path across the full 7 days, there is NO occurrence of
`conversation_lifecycle_busy` on the ingest route before that window.** A first count of 4 was wrong
— a raw string grep that double-counted each event via its `[vc:debug]` echo and did not separate
prepare from ingest. **Two events, both on prepare.**

> **THEREFORE: this retry covers ZERO naturally-occurring ingest failures.** It is a correct fix for
> a condition that has never occurred on its own. **That is a reason to keep it staged, not a reason
> to delete it** — but deploying it must not be described as reducing turn loss, because on the
> record it reduces none.

**The natural population is five, and all five are timeouts.**

**This is the most important number in the document and it was nearly missed.** Everyone reasoned
from the 503 because **it announced itself** — a type, a `retryable` flag, a `Retry-After` header.
**The timeouts carry none of that**, which is exactly why they went unexamined despite being **six
times more common.** A legible failure crowded out a silent one.

**Consequence for the design, stated bluntly:**
- The rule in §3.2 covers **1 of 7** observed drops.
- **The other 6 cannot be fixed by ANY rule that keys on the receiver's answer, because there is no
  answer** — a timeout has no status, no body and no type.
- **A timeout is also the worst case for duplication**: the request may have committed and only the
  response was lost.

**So an idempotency key is the load-bearing fix, not the elegant alternative.** Without one, timeouts
are unretryable by construction. With one, all seven become safely retryable and §0's blocker stops
mattering.

#### The key exists on this side, and it is measured

`source_message_id` was **`None`** on the turn that failed — so a key built from it is unavailable in
exactly the case that broke. **`sessionId` is not:**

```
ingest lines WITH a session id : 152
ingest lines WITHOUT one       : 0        (3-day window)
```

Present on 100% of turns including cron. For a **per-turn** key it must be paired with `runId`,
since a session spans many turns. **`runId`'s presence rate has NOT been measured** and must be
before anything is built on it.

### 2.3a The counters this needs, and the no-data state

Requiring "a member-facing denominator" is not a design until the predicates are named. **Today the
code excludes only `heartbeat` — explicitly not cron — and treats `NO_REPLY` as ordinary assistant
text.** So none of the required distinctions exist yet.

| Counter | Predicate |
|---|---|
| `eligible` | member-facing **and** produced content — cron excluded, `NO_REPLY` excluded |
| `pathTotal` | every `agent_end` ingest attempt, cron and `NO_REPLY` included — **path health, not exposure** |
| `retryableFailures` | failures the rule would act on |
| `recovered` | retries that succeeded |
| `terminalLoss` | retries exhausted — **the number that matters** |
| `prepareFailures` | counted **separately**, never summed with ingest (§2.2) |

> **A no-data state is mandatory.** `terminalLoss=0` must be distinguishable from *no eligible turns
> occurred*, *the instrument is not wired*, and *cron/`NO_REPLY` landed in the wrong denominator*.
> Print the denominator beside every verdict, and print `NO DATA` explicitly rather than a zero.

### 2.4 The cause is CLOSED AS UNTESTABLE

All three 503s fall in a ~03:03–03:07 UTC window, and two candidate causes sit there — a daily PG
backup and a nightly cron. **Neither can be tested from existing data**: the canary runs at
:31–:34 past the hour and **has never run at :01–:05**, so a negative control for that window has
never existed. Every backup window has been untested except when a member happened to be awake.

**The correlation is neither strengthened nor weakened, and this spec does not depend on it.** The
design relies only on the condition being **bounded and self-clearing**, which is what a
`Retry-After` is for and which does not require knowing the cause.

---

## 3. Design

### 3.1 The blast radius is larger than the fix looks

`vcPost` throws a **plain `Error` carrying only a truncated message string**:

```js
throw new Error(`VC API ${res.status}: ${text.slice(0, 200)}`);
```

**It discards the numeric status, the parsed body, and every header — including `Retry-After`.** So
the header the receiver is already sending is **unreachable from any caller**, and `vcPost` is shared
by prepare, ingest, tools, capabilities, exact-source ingest and the late path.

**Requirement: enrich the error additively, do not change its shape.**

```
err.message        unchanged  -- every existing catcher keeps working
err.status         number
err.retryAfterMs   number | null   (parsed from the header, null if absent/unparseable)
err.retryable      boolean | null  -- NESTED: `body?.error?.retryable === true`, NOT
                                      `body.retryable`. The observed body puts it under
                                      `error`, so an implementation reading the top level
                                      would fail to retry the exact failure this spec exists
                                      for. Pin the real shape with a test.
err.body           parsed object | null
```

#### The safety of "additive" is a property of the CONSUMERS, not of the change

**"No existing catcher changes behaviour" is a claim about six catchers, and it must be tested per
catcher rather than asserted.** `err.message` staying identical is necessary and not sufficient — a
catcher can branch on the error's shape, its `instanceof`, its **enumerable keys**, or serialise it
into a log line something downstream greps.

> **REQUIREMENT: enumerate every `vcPost` catcher and pin each with a test that fails if enrichment
> changes its behaviour.** A survey is not evidence. Any catcher that stringifies or serialises the
> error is the dangerous case, because adding enumerable properties changes that output.

#### Retiring an existing defect is the stronger justification for this change

`outboundIdFailureIsPermanent` currently recovers the HTTP status by **regex over the error message
string** — a string another part of this same file formats. **Change the format and the classifier
mis-reads silently, with no error anywhere.** That is a live two-rulers defect, not tidiness.

**So enrichment removes an existing hazard as well as enabling a new capability.** A change that only
enables is a harder sell than one that also deletes a defect, and this is the latter.

### 3.1a WHERE the retry lives — NOT in `vcPost`

**`vcPost` gets enrichment only. The retry goes in a narrow legacy-ingest wrapper.**

`vcPost` is called by **seven** paths — completion-outbox delivery, outbound-id late delivery,
legacy ingest, dynamic tools, slash-command prepare, before-agent-reply command prepare, and normal
prepare. **Putting the retry inside it hands a new retry policy to all seven**, including
side-effecting tool and command paths, and silently violates this spec's own "no prepare-path
change" boundary.

### 3.2 The retry rule

1. **Retry only on a NAMED TYPE that is guaranteed pre-persistence.** Not on 5xx, not on
   `retryable: true`, and **not on the type as it exists today** — see §0. `retryable: true` is
   necessary and nowhere near sufficient: cause B sets it and is post-write.
2. **Honour `Retry-After`. Do not hardcode a delay.** The receiver knows how long its condition
   lasts and the sender does not. Absent or unparseable header → a conservative default, capped.
3. **Bounded attempts**, small. This is a contention window, not an outage: 2–3 attempts, not 4096.
4. **A terminal failure is LOGGED AS A LOSS, loudly and distinctly** — not one `log.error` among
   many. Today's drop surfaced only because a monitor filter happened to be broad enough to catch a
   line nobody was watching for. **A lost turn must be its own signal.**
5. **Bounded WALL-CLOCK, below the run-bound group finalization timer (30s).** Not just bounded
   attempts. That timer logs `ingest SKIPPED` and releases state in a `finally`, so a retry still in
   flight past it produces **a false loss signal and a cleanup race** — the instrument reporting a
   loss that did not happen, while the write is still going. Either cap total retry time under the
   timer, or clear the timer when finalization starts.

### 3.3 Retry in place, or route the legacy path through the existing outbox? — **IN PLACE.**

Reuse looks like less new code and **is not available** — but for **one** of the two reasons first
given, not both.

**CORRECTION:** the blocker is the **`exact_source_admission` generation token and the ordering**,
**not** a missing `source_message_id`. A legacy turn *can* have one: it is derived from current-turn
provenance and carried in legacy pending state, and `queueExactCompletion` reads
`payload.source_message_id`. **The false subclaim mattered because it hid an available idempotency
ingredient** — see §2.3.

Admitting them would mean weakening that admission — which is **exactly the hazard the outbound-id
spec rejected in its §5.1**: the outbox enforces one FIFO head per conversation, so a blocked record
holds every later record for that conversation, and those carry real users' turns. **Reusing it would
trade a rare dropped turn for a systemic stalling risk.**

**So: a bounded in-place retry on the legacy path, sharing the enriched error but not the outbox's
ordering or retry domain.** Same conclusion, same reasoning, as I-5.

---

## 4. What this spec does not do

- **No blanket 5xx retry.** Only `retryable: true`.
- **No durable queue for legacy turns.** A retry across a process restart is a much larger design
  and is not justified by n=3 in a self-clearing window.
- **No change to prepare-path behaviour.** Different harm (§2.2), different owner, out of scope.
- **It does not claim a cause.** Backup contention and the nightly cron are both live candidates and
  n=3 separates neither.

---

## 5. Open

| # | Question | Owner |
|---|---|---|
| 0 | **Split the error type so cause B is distinguishable (§0). Until then this spec cannot be built.** | cloud@vc |
| 1 | Is `Retry-After` sent on **every** `retryable: true`, or only this error type? The rule depends on it. | cloud@vc |
| 4 | **An idempotency key — the only fix that covers the 6 timeouts.** `sessionId` is available; `runId` needs a presence measurement first. | cloud@vc, with this side |
| 2 | Should a terminal loss also be surfaced outside the log — a counter in the periodic report? | this side |
| 3 | Does the prepare-path 503 (§2.2) want its own handling, and whose? | cloud@vc / lead |
