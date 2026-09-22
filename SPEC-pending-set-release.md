# Spec: releasing a pending outbound identity after it is carried

**Status:** DRAFT v1 — **spec only, nothing built.** Companion to `SPEC-outbound-message-id.md`;
its five invariants (I-1..I-5) govern here unchanged and **I-1 is the binding one.**
**Owner:** openclaw@vc.

---

## 0. The defect, in one line

**`forgetPendingOutboundIds` is exported, unit-tested, and has no production caller.**

```
$ grep -n "forgetPendingOutboundIds(" index.js
4523:export function forgetPendingOutboundIds(state, convId, identityKeys) {
$ grep -rn "forgetPendingOutboundIds" tests/
tests/outbound-message-id.test.js:12:   forgetPendingOutboundIds,
tests/outbound-message-id.test.js:347:  expect(forgetPendingOutboundIds(state, "c", [...])).toBe(1);
```

**Its only caller is its own test.** Nothing removes an identity from the pending set after it has
been carried, so **an identity is re-offered on every subsequent ingest for its conversation until
something evicts it.**

> **A test proves a function works. It says nothing about whether anything invokes it.**
> This is the fourth surface in this feature built, tested, and never connected, and **all four
> were caught by something other than the tests.** A green suite shows neither a signal that never
> reaches behaviour nor a behaviour that is never reached. **Check: for any exported function, grep
> for callers outside its own test file. Zero is a defect, not a coincidence — and coverage tools
> hide it by counting the test as a caller.**

**Safe on the wire.** I-3 makes the field an additive idempotent set and the receiver answers a
re-offer as `duplicate`, an explicit success. **This is a measurement defect, not a data defect** —
which is exactly why it has survived, and why §4 matters more urgently than §2.

---

## 1. Why it matters NOW rather than eventually

**Post-seal, identities start being accepted.** The ledger's counts are what we intend to judge the
chain by — and **every ingest re-offering everything still in the bucket inflates `offered` and
`duplicate` by an amount nobody reading them can recover.**

### 1.1 MEASURED — the inflation is QUADRATIC, not a constant overhead

Observed in production 2026-08-21, four consecutive turns in one conversation:

```
events=1  witnessed=1  carriedExact=0
events=2  witnessed=2  carriedExact=1
events=3  witnessed=3  carriedExact=3
events=4  witnessed=4  carriedExact=6
```

**0, 1, 3, 6 are the triangular numbers.** Each ingest carries the whole accumulated bucket, so
after `n` identities in a conversation the total carries are **`n(n+1)/2`**. **Three distinct
identities produced six carries.**

> **`offered` does not overcount by a constant factor.** The growth is triangular **while the bucket
> fills**, and then it PLATEAUS — see §1.1a, which corrects the sustained-quadratic reading. **Any rate computed against it is
> wrong by an amount that depends on how busy the conversation was** — the worst kind of error,
> because it varies with the thing being measured.

**CONFIRMED ON THE WIRE BY THE RECEIVER, 2026-08-21 18:23Z** — an independent instrument, not a
second reading of the same counter:

```
offered=3   accepted=1   duplicate=2
```

**Three carries, one new identity, two re-offers of identities the receiver already held.** That is
this defect decomposing exactly as I-3 predicts, measured from the far side of the wire. **`duplicate`
here is not double delivery and not a sender fault — it is the bucket that never drains.**

It also confirms **zero releases ever occur**: the sequence is exactly `Σ` with no subtractions.
**The dead caller is not merely unreferenced — its absence is visible in production arithmetic.**

### 1.1a CORRECTED — the steady state is a ROLLING WINDOW, not unbounded growth

**The receiver refuted the sustained-quadratic reading with per-request data:**

```
offered, per request, in order
  guild    1 2 3 1 2 3 3 2 3
  channel  1 1 1 2 3
```

**It never exceeds 3 and it falls back.** Unbounded accumulation would climb monotonically.

**The explanation, and it makes the bound predictable rather than mysterious.** Pruning is
write-triggered, so on each new identity every entry older than `OUTBOUND_ID_PENDING_TTL_MS`
(15 min) is evicted. In a conversation with inter-turn gap `g`, the bucket therefore holds a
**rolling window** of roughly:

```
steady-state bucket  ~=  TTL / g        (then capped by MAX_CARRIED_PER_INGEST = 32
                                          and MAX_PENDING_PER_CONVERSATION = 64)
```

**Measured inter-turn gaps, fleet-wide, from delivery timestamps:**

```
median gap                    4.2 min      (944 gaps)
gaps under the 15-min TTL     675 / 944 = 72%
busiest conversation          median 3.5 min, 561 deliveries
tightest conversation         median 1.9 min
```

**DO NOT PREDICT THIS FROM A STATISTIC.** `TTL / median` was tested against per-request data and
**under-predicted** — 2.0 predicted against 3 observed on one channel — because these gap
distributions are **bimodal**: short bursts separated by hours of quiet. **The median sits between
the two modes and describes neither**, and a bound that reads low is the dangerous direction.

**Simulate instead.** Replay the real delivery timestamps through the shipped eviction rule — prune
on write, drop entries older than the TTL, then insert — and read the maximum bucket directly:

```
conversation                    n   median     min     p10   SIMULATED MAX
guild  …1524917037191925871   561    3.5m    0.0m    0.8m        16
channel …1524918613008580768  149    3.5m    0.2m    0.9m        13
channel …1524949287501566013   25    3.0m    1.0m    1.5m         8
channel …1524946242499514418   85   22.9m    0.9m    1.5m         5
… nine more, all ≤ 5

FLEET MAX SIMULATED BUCKET = 16      caps: 32 per ingest, 64 per conversation
```

**16, not 3 and not 4.** The median-derived figure (4.3) and the minimum-derived figure (18.8)
bracket it, which is why neither is the answer — **the true value is a property of the sequence, not
of any summary of it.**

> **RETRACTED — the 16 is an artefact. See the correction immediately below.**

#### 1.1a-CORRECTION — the simulation was fed events from before the feature existed

**`carry` mode shipped 2026-08-20 16:03:23Z. The pending set did not exist before that instant**, so
every delivery earlier than it contributed a phantom entry to the replay.

```
window                                   deliveries  convs  MAX BUCKET
ALL history (feature NOT live for most)         961     16      16   <- the retracted figure
SINCE carry mode went live                       47      6       4   <- the real one
receiver's 3-day ring (also pre-dates carry)    157     12       8   <- also contaminated
```

**The correct maximum is 4, not 16.** The eviction rule was simulated faithfully; **the event stream
was not the one the rule ever saw.**

**And it reconciles exactly with the wire.** The receiver measured the shipped
`_vc_agent_outbound_ids` array across 3 days and 33 carries: `{1:15, 2:10, 3:8}`, **max 3.**

```
simulated pending set (since live)   4
observed wire payload                3
difference                           1  = the identity inserted at message_sent for the
                                          CURRENT turn, which is not yet available at that
                                          turn's own ingest (SPEC-delivery-time-identity-merge §1)
```

> **Two independent instruments, agreeing to within a known off-by-one, both saying the bucket is
> small. The alarming version was mine and it was wrong.**

**BOTH windows were audited for the same contamination, not just the one that failed.** The receiver
re-split their 33 captures at the go-live instant rather than assuming a real-payload measurement
could not be window-contaminated: **1 capture predates it by 3m14s carrying a single identity, and
32 follow it.** It cannot move a maximum of 3 and does not.

> **The contamination is a property of the WINDOW, not of the instrument** — so reading real
> payloads off the wire confers no immunity. *"My measurement was of the real wire so it cannot be
> contaminated"* is precisely the reasoning that would have skipped the check.

**The headline as of the quiet window was: the bucket reaches 4 against a per-ingest cap of 32.**
**That reading is superseded — see §1.1b. It was measured in a regime that could not test it.**

### 1.1b THE SUSTAINED REGIME ARRIVED — observed 10 and climbing, 2026-08-21 21:54Z

**Both prior readings (3 on the wire, 4 simulated) came from quiet traffic. A burst tested the model
properly and it climbed monotonically:**

```
offered  4  5  6  6  7  8  9  10        accepted=1 on every line
delivery gaps  ~1.8 0.8 1.1 1.9 1.7 1.2 1.4 0.85 0.3 min   median ~1.2

TTL / gap = 15 / 1.2 = 12.5   predicted ceiling
OBSERVED  = 10 and still rising
```

**The rolling-window model lands within a couple of entries, on the right side, in the regime that
actually discriminates.** A quiet window cannot tell a bounded model from a broken one; this one can.

> **The margin to the 32 cap is roughly 3x, not the order of magnitude the quiet reading implied.**

**And the inflation factor is not a constant.** Measured over this burst: **`offered` 55 against
`accepted` 8 — 6.9x**, where the quiet window gave 2.00x. **Quote the formula, never the number:**

```
inflation = 1 + mean carry-over,     carry-over tracks TTL / inter-turn gap
```

### 1.1c THE THRESHOLD AT WHICH IT STOPS BEING ONLY AN INFLATION

`pendingOutboundIdsForConversation` slices to the **last** `OUTBOUND_ID_MAX_CARRIED_PER_INGEST = 32`
entries. **So once the bucket exceeds 32, the OLDEST identities are silently dropped from the carry.**

```
bucket ~= TTL / gap  >  32     =>     gap  <  15 min / 32  =  28 seconds
```

> **A conversation sustaining sub-28-second turns would stop offering its oldest identities.** As of
> `ae63961` a counter reports it (`droppedByCap`); before that nothing did, on either side of the
> wire.

**THE MARGIN IS IN DURATION, NOT SPEED — and every figure below understates it.**

```
tightest gap observed anywhere        17.6s    <- already INSIDE the threshold
longest sub-28s streak observed        >= 3    <- the cap needs ~33
peak bucket                          >= 12     <- cap is 32
truncations ever                          0
```

**Both available gap measurements omit events**, and the omission runs one way only:

| Instrument | Counts | Misses |
|---|---|---|
| sender-side | **deliveries**, where the quantity depends on **witnesses** | 73 witnesses vs 64 deliveries since go-live |
| receiver-side | only identities **successfully carried** | every uncarried delivery, ~62.5% coverage |

**A missing event MERGES two real gaps into one longer one**, so measured gaps are inflated and
measured streaks are broken. **Neither instrument can overstate the speed.**

> **Defensible statement, needing no further measurement: the SPEED is already reachable — it
> happened during an ordinary burst — the sustained DURATION has never approached the cap, and every
> number either side holds is a lower bound on the risk.**

**The exact figure needs correlating each dispatch back to a turn.** The `message_sent` hook line
carries no session key, and the bucket is keyed per conversation, **so per-conversation witness gaps
are not computable from the log as it stands.** Not worth building for this question. The inflation is real, measured at **2.00x** receiver-side, and it
is **not** approaching any bound at this traffic.

**The triangular 0, 1, 3, 6 in §1.1 was the FILL PHASE of a fresh conversation**, which is real and
is the first three or four turns. **It is not the sustained regime, and reading it as one overstated
the defect.**

> **The inflation factor, measured receiver-side over 14 requests: exactly 2.00x** — 28 offered,
> 14 accepted, 14 duplicate. **That is the number to quote, not a growth rate.**

**What this does NOT establish:** a conversation sustaining gaps well under the TTL would hold a
larger window, and **the busiest run observed is only `offered=3`.** Absence of the growth is
evidence this traffic never triggered it, not evidence it cannot occur. **The bound is
traffic-dependent, and it is bounded by EXPIRY rather than by correctness** — nothing here releases
an identity because it was successfully carried.

### 1.2 COROLLARY, ALSO OBSERVED — a conversation's FIRST turn carries nothing

Event 5 was the first delivery to a *different* channel. **`carriedExact` did not move: 6 → 6.**

An identity cannot exist at its own turn's ingest (`SPEC-delivery-time-identity-merge.md` §1), and a
brand-new conversation has no earlier identity to carry. **So the first agent message in any
conversation is carried by the second, and a conversation with exactly one agent message never lands
its identity at all.**

The receiver saw no new offer for it — ledger rows and offers both unchanged — **a second instrument
agreeing with the sender-side counter. Predicted behaviour observed rather than derived.**

---

The inflation is bounded but not small. Per conversation the pending bucket holds up to
`OUTBOUND_ID_MAX_PENDING_PER_CONVERSATION = 64`, and each ingest carries up to
`OUTBOUND_ID_MAX_CARRIED_PER_INGEST = 32`. **So a single identity in an active conversation can be
offered dozens of times**, and `offered` counts carries rather than identities.

**The fix and the interpretation are on different clocks. The interpretation is needed immediately;
the fix is not.** §4 is therefore normative for readers *today*, independent of whether §2 ever
ships.

---

## 2. The removal rule — and why it is narrower than it looks

### 2.1 Per-identity attribution DOES NOT EXIST, so "remove the accepted ones" is not expressible

The acknowledgement is **Tier 1: counts, not per-identity outcomes.** Worse for this purpose, the
adapter already lumps two states together by design:

```js
const acceptedCount = n("accepted") + n("duplicate");
```

**So the receiver's answer cannot say WHICH identities were accepted, and cannot even separate a
first acceptance from a re-offer.** Any rule of the form *"remove the ones that were accepted"*
requires information the wire does not carry.

### 2.1a ANSWERED BY core@vc: `duplicate` means the row EXISTS, and it is per identity

The gating question — *can `duplicate` mean "I have seen this" rather than "I hold this"* — is
answered **no**, and the answer is structural rather than a convention that could drift:

```sql
INSERT INTO bot_outbound_messages (...) VALUES (...)
  ON CONFLICT (tenant_id, agent_scope_id, platform, account_id, channel_id, message_id)
  DO NOTHING
  RETURNING 1
```

`ON CONFLICT ... DO NOTHING` fires **only when a row with that exact primary key currently exists**,
evaluated against the live unique index at execution time. **There is no seen-set, cache, or memo
anywhere in that path** — `duplicate` is the table reporting the row is there.

**And nothing removes it.** There is no `DELETE`, `TRUNCATE`, or prune path for
`bot_outbound_messages` in the receiver's package, and `reset_conversation_derived_data` — which
clears eleven other tables — **does not touch it.** The ledger is append-only in practice, so a
`duplicate` answer does not decay into a lie later.

**Per identity, confirmed:** the write loop is one INSERT per identity, incrementing `accepted` or
`duplicate` once each, and declines increment once per element too. **Reading
`accepted:1, duplicate:2, fence_rejection:1` as a mixed per-identity answer is correct.**

**So the release signal is `accepted + duplicate`.**

### 2.1b THE RECEIVER CAN ACCOUNT FOR MORE THAN WAS SENT — and it does not break the rule

The receiver's pool is `autocommit`, so **every INSERT commits as it executes.** If the write throws
on row 3 of 5, rows 1 and 2 are already durably written **and already counted**, and then the
handler counts the **whole** batch declined:

```python
except Exception:
    for _ in rows:
        _decline("store_unavailable")
```

**One identity can therefore be reported as both `accepted` and `store_unavailable`, and the outcome
totals can exceed the number offered.**

**This is being fixed at source rather than documented as permanent** — the repair tracks how many
INSERTs actually committed and declines only the remainder, restoring
`accepted + duplicate + declines == len(observed)` as an invariant. **Until it lands, the sender-side
`ackOverAccounted` counter observes it from the other side of the wire**, which makes a non-zero
reading direct evidence of the partial-write path firing rather than an inference. **After it lands
that counter should sit at zero permanently, and a non-zero reading becomes a regression signal for
the fix rather than dead instrumentation.**

**The release rule survives unchanged, and it is worth saying why rather than asserting it.**
`accepted` and `duplicate` are incremented **only when an INSERT actually executed**, so
`acceptedCount` is a true lower bound on rows written; and `acceptedCount ≤ len(rows) ≤ carried`,
because validation can only shrink the batch. So `acceptedCount >= carried` is reachable **only when
every carried identity validated and wrote.** Over-accounting inflates the *decline* side, which
this rule never releases on — **the failure mode pushes toward over-retention, which is the
direction §2.3 chose deliberately.**

### 2.2 THE RULE: remove only under unambiguous, complete acceptance

```
ack.state === "accepted" AND acceptedCount >= carried
    -> release exactly the identity keys this ingest carried
       (acceptedCount = accepted + duplicate; see 2.1a -- both mean the row exists)
anything else
    -> RELEASE NOTHING
```

**Partial acceptance releases nothing.** With `carried=4, accepted=1` there is no way to know which
one, and guessing would drop three identities that were never recorded. **I-1: absence is unknown.**

### 2.3 NEVER RELEASE ON A DECLINE. NOT EVEN A PERMANENT ONE.

**Removal is irreversible from this side.** The engine never re-presents anything — the only two
call sites are on the live turn path (`SPEC-outbound-id-resend.md` §1) — so an identity released
here and lost there is gone from every system.

**And the taxonomy has already been wrong about "permanent" once.** `epoch_start_unknown` was
classified permanent and **became acceptable the moment the epoch boundary was sealed.** Every
identity declined under it was recoverable in principle and unrecoverable in practice, precisely
because nothing on this side had kept it. **A rule that released on permanent declines would have
made that loss automatic and silent.**

> **Retaining a carried identity costs an inflated count. Releasing one wrongly costs the identity.
> Those are not comparable, and the rule must be asymmetric.**

### 2.4 Where it goes

In `ingestWithOutboundIds`, on the success path only, after `noteOutboundIdAck` — which is the only
place that has both the ack and the exact key set that was carried. **The key set must be captured
BEFORE the POST**, not recomputed after: a `message_sent` arriving mid-flight would otherwise make
the release set differ from the carried set.

---

## 3. THE TTL IS NOT ENFORCED ON READ — the same defect, other half

Found while measuring the pending set for a restart decision, and **it is why an identity 45 minutes
old was still resident under a 15-minute TTL.**

`prunePendingOutboundIds` has exactly one caller, `rememberPendingOutboundId`. **Pruning is
write-triggered. Reads never filter by age.**

```js
export function pendingOutboundIdsForConversation(state, convId, limit) {
  const bucket = state.get(convId);
  if (!bucket || bucket.size === 0) return [];
  const entries = [...bucket.values()];
  return entries.slice(Math.max(0, entries.length - limit));   // no age check
}
```

**Consequences, both real:**

- **`OUTBOUND_ID_PENDING_TTL_MS` is not a bound on an identity's age at carry.** In a quiet
  deployment an entry survives arbitrarily long and is carried long past its nominal expiry.
- **Eviction is coupled to unrelated traffic.** The next `message_sent` in **any** conversation
  sweeps the whole map, so whether an identity survives to be offered depends on which of two
  unrelated events happens first. **That is a race decided by traffic in other conversations.**

**Fix: filter by age on read as well as on write, from the same constant.** The reader and the
pruner must use the **same ruler**, or the set's stated bound and its actual behaviour disagree —
which is what happened here.

---

## 4. NORMATIVE UNTIL §2 SHIPS — how to read the ledger

**These apply to every number quoted about this feature today.** They are not caveats; a reading
that ignores them is wrong.

| Field | What it actually counts |
|---|---|
| `offered` | **Carries, not identities.** One identity offered N times contributes N. |
| `duplicate` | **Overwhelmingly re-offers of an identity this sender already had accepted** — not double delivery, not a retry, not a sender defect. **A high duplicate rate is the expected shape.** |
| `accepted` | First acceptances **plus** re-offers, because the adapter sums `accepted + duplicate`. |
| `carriedExact` (sender side) | **Carries, not distinct identities.** This is why `carriedExact=4` appeared against `witnessed=5`. |

**Therefore:**

- **DISTINCT identities on record ≈ `accepted` on FIRST offer only, which no counter isolates.**
  The nearest honest proxy is the receiver's own row count, not anything in this report.
- **NEVER compute an acceptance rate as `accepted / (accepted + declined + duplicate)`.** The
  denominator mixes identities with carries and the ratio is meaningless.
- **A rising `duplicate` count is not evidence of anything changing.** It tracks conversation
  activity, because a busier conversation re-offers its bucket more often.

> **Until §2 ships, `offered` and `duplicate` describe how often the sender talked, not how many
> identities exist.**

### 4.1 `duplicate` IS INFLATED FROM BOTH ENDS, BY TWO UNRELATED DEFECTS

This is the part that makes it untrustworthy rather than merely imprecise:

| End | Mechanism | Effect |
|---|---|---|
| Sender (§0) | the pending set never drains, so every ingest re-offers the whole bucket | `duplicate` counts re-offers |
| Receiver (§2.1b) | autocommit + whole-batch decline on a partial write failure | one identity counted under two outcomes; totals can exceed what was sent |

**Neither end can back the other's inflation out of the number, and the two are independent, so the
error does not even have a consistent sign.**

**The trustworthy signals, and they are the only two:**

1. **`accepted` transitioning off zero.** The event, not the magnitude.
2. **`SELECT COUNT(*) FROM bot_outbound_messages`** — currently 0, and **inflatable by neither
   defect** because it counts rows rather than outcomes.

> **Judge the post-seal chain on the ledger row count. Do not judge it on `duplicate`.**

---

## 5. What the tests must discriminate

Ordinary coverage would pass on a no-op here, so:

1. **Two ingests, one witnessed identity, full acceptance on the first → the SECOND carries
   nothing.** Fails today. This is the test the feature exists for.
2. **Partial acceptance releases nothing** — `carried=4, accepted=1`, second ingest still carries 4.
3. **A permanent decline releases nothing.** Negative control uses `epoch_start_unknown` by name,
   because that is the reason that was wrong.
4. **An unreadable or absent ack releases nothing.**
5. **An identity witnessed mid-flight is NOT released** by an ack for a POST that never carried it.
6. **Read-side ageing:** an entry past the TTL is not carried, with **no intervening write**. Fails
   today, and no existing test can catch it because they all write first.
7. **A caller-existence check for every exported function in the outbound-id block** — grep for a
   caller outside its own test file. **This defect class is now four for four; the check belongs in
   the suite, not in someone's memory.**

**Mutations required:** release on partial acceptance; release on permanent decline; release the
recomputed set rather than the captured one; read-side age filter using a different constant from
the pruner.

---

## 6. What this does NOT do

- **It does not make the pending set durable.** It stays in memory and a restart still discards it.
- **It does not add per-identity outcomes to the acknowledgement.** §2.2 is deliberately built to
  work without them.
- **It does not recover anything already lost.** That is `SPEC-outbound-id-resend.md`, still blocked
  on the unpublished late-path route.

---

## 7. Open

| # | Question | Owner |
|---|---|---|
| 1 | Should a full-acceptance release also require `ackUnaccounted === 0`? Probably yes — an unaccounted identity is by definition not known to be recorded. | this side |
| 2 | ~~Does the receiver ever answer `duplicate` for an identity it does not hold?~~ **ANSWERED: no — see §2.1a. Release on `accepted + duplicate`.** | core@vc |
| 3 | Should the receiver's partial-write double-count (§2.1b) be fixed at source, or documented as a permanent property of the counts? It is harmless to this spec and harmful to anyone reading the ledger's outcome totals. | core@vc |

**Question 1 is the only one still gating anything, and it gates a detail rather than the design.**
