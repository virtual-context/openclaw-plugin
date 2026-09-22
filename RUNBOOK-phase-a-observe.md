# Runbook: Phase A — deploy `outboundIdCapture.mode = "observe"`

**Purpose.** Convert §2 of `SPEC-outbound-message-id.md` from *static analysis of the shipped
gateway bundle* into *measurement against real traffic*. Until this runs, every claim in §2 is read
from `dist/` and could be wrong.

**Status: PREPARED, NOT ARMED.** Nothing below has been executed.

---

## 0. Why this does NOT wait on cloud@vc

Worth stating up front, because the two were coupled in an earlier plan and they are not:

| | needs cloud's unknown-field answer? |
|---|---|
| `mode: "observe"` | **No.** It registers a hook, counts, and logs. **It cannot change a single byte on any wire** — the fast-path field is gated on `carry`, and the late queue is gated on `carry && latePath`. |
| `mode: "carry"` | **Yes.** That is the mode that puts a new field on the ingest body. |

So Phase A is independently deployable **now**, and it is the step that produces the measurement
everything else is being designed against.

---

## 1. Preconditions — VERIFIED on prod 2026-08-20, not assumed

| Check | Required | Measured | Source |
|---|---|---|---|
| `convIdentity` | `"stable"` | `stable` | live `openclaw.json` |
| Plugin enabled | true | true | live `openclaw.json` |
| Gateway version | ≥ 2026.3.24 | **2026.7.1-beta.2 (`a580a7f`)** | `openclaw --version` |
| Prod plugin commit | any | **`2a41ac6`** — six commits behind | `git rev-parse` on prod |
| Prod tree clean | yes | yes (2 untracked `.vc-deploy-*` scratch dirs + 1 `.bak`) | `git status` on prod |
| Per-agent VC keys | — | **`agentKeys=1` (`gymbrobot`)** | boot log |

**The `agentKeys=1` line matters more than it looks.** A second VC key is live in production, which
makes the cross-credential fix (pending ids keyed by `(deployment_id, conv_id)`, not `conv_id`
alone) **load-bearing in prod rather than theoretical**. Without it an id witnessed under one key
could have ridden an ingest authenticated by the other.

### 1.1 A pre-existing finding, NOT caused by this work

Prod logs on **every boot**:

```
[vc] conversationGroups: wildcard member "agent:vast:discord:channel:*" is not certified
     for "agent:vast:discord:guild:1524917037191925871" — member ignored
```

and `groupedSessions=0`. **The configured wildcard is not in effect.**

The refusal is **correct**: `buildCertifiedConversationGroupWildcards` certifies a terminal
`discord:channel:*` only when the bound account's group policy is an allowlist with **exactly one**
explicit guild. The `vast` account has **two** (`1524917037191925871`, `1536837329522532362`), so
`discord:channel:*` is ambiguous — a channel could belong to either, and mapping all of them onto
one guild key would cross a guild boundary. The guard is doing its job.

It is also **not silent** — it warns on every boot, and that instrument works.

**Consequence for this feature: none, and the reason is the one that matters.** Guild-channel
conversations key per channel (`sk:agent:vast:discord:channel:<id>`) rather than per guild. The
outbound binding and the ingest path both resolve through the **same** derivation, so they agree.
There is no ruler mismatch. Worth surfacing to whoever set that config, since it expresses an intent
that is not taking effect — but it is out of scope here.

---

## 2. The change

Add one key to `plugins.entries.virtual-context.config` in `/root/.openclaw/openclaw.json`:

```json
"outboundIdCapture": { "mode": "observe" }
```

Deliberately **no `latePath`**. Without it the durable queue is never written and the worker never
runs — see the §5.4 ship gate. `mode` alone is inert on the wire.

---

## 2.5 BEFORE YOU RESTART ANYTHING — a restart destroys pending identities

**READ THIS FIRST IF YOU ARE ABOUT TO RESTART THE GATEWAY.** It is the part that is easy to skip and
was skipped five times on 2026-08-21.

**A gateway restart discards the in-memory pending set.** Identities witnessed but not yet carried
are gone — not delayed, gone. **There is no durable backstop unless `latePath` is configured, and it
is not.**

### What it cost on 2026-08-21, in numbers rather than advice

```
restarts performed that day                                    5
identities lost that day (one conversation, fully traced)      3
  16:22:21   swept by unrelated traffic 84 min later           <- ordinary operation
  18:26:27   DESTROYED BY A RESTART, 21 seconds after witness  <- a deploy did this
  18:30:34   evicted by a later prune                          <- ordinary operation
```

**One of the three was killed by a restart performed to ship a change.** The deploy was authorised
with the cost stated as *"a brief restart, capture budget preserved by design"* — **which was the
complete cost as understood at the time, and it was wrong. The pending-set loss was not in anyone's
model, so a restart was priced at zero and five were spent.**

### Price it BEFORE you restart

**Two methods. The applicability test is part of each one — do not carry the formula away without
it.**

**METHOD 1 — only when the most recent report is FRESH and `carriedExact <= witnessed`:**

```
witnessed - carriedExact  ~=  identities pending right now
```

> **IT IS INVALID THE MOMENT RE-OFFERS ARE ACTIVE.** Nothing releases an identity after it is
> carried, so `carriedExact` counts carries and can exceed `witnessed`. **When it does, this formula
> returns a negative number and means nothing.**
>
> **Worked example, 2026-08-21 21:44Z:** `witnessed=5 carriedExact=6` → **−1**. That is the formula
> failing, not zero identities pending.

**It also needs the report to be CURRENT.** Reports print at `events <= 5` then every 25, **so between
events 6 and 24 there is no fresh reading at all** and the last one may be an hour old. **A stale
`witnessed − carriedExact` is arithmetic on two old numbers.**

**METHOD 2 — when method 1 is unavailable, read the DELIVERY PATTERN instead:**

```
message_sent dispatches  vs  outbox deliveries, since the last report
   grep -c "running message_sent ("      <- the trailing paren is required
   grep -c "vc:outbox] acknowledged"
```

**One-for-one means the pending set is draining continuously** — each delivery is an ingest that
carried whatever was pending for its conversation — **so little or nothing is sitting.** That is a
comparatively cheap moment to restart.

**Dispatches exceeding deliveries means identities are accumulating** with no ingest to carry them.
**That is the expensive moment**, and it is the shape the 18:26 restart hit: a witness 21 seconds
before, in a conversation that then went quiet.

> **Method 2 gives a direction, not a count.** Say which method produced the figure when reporting
> it. **"0 to 2, estimated from the delivery pattern" is honest; a bare number implies a reading
> that was not taken.**

> **RULE, until the trigger-plus-fallback design in `SPEC-delivery-time-identity-merge.md` §3 lands:
> BATCH DEPLOYS. A change that only improves an instrument must wait for one that has to ship
> anyway. One restart, one cost, paid deliberately.**

**And if something forces a restart before then, state what is pending first** — deciding with the
count is different from discovering it afterwards, which is what happened every time that day.

---

## 2.6 THE INDEPENDENT DENOMINATOR — the command lives HERE, not in the log line

**`sent_per_sending` in the plugin's report compares the plugin against itself.** Both hooks are
dispatched by the host in one process, so **if the host stops dispatching, both fall to zero together
and the ratio stays at 1.00.** A perfect score and a dead instrument are indistinguishable from it.

**The real denominator is the host's own dispatch line:**

```
journalctl --user -u openclaw-gateway --no-pager --since "<boot>" \
  | grep -c "hooks] running message_sent ("
```

**The trailing open paren is required.** The hook line ends `running message_sent (1 handlers)`.

### Why this command is in the runbook and NOT in the report line

**Three versions of that log line printed a pattern for the reader to grep, and each one was matched
by the command it recommended:**

```
v1  printed the bare phrase                          -> report matched, count DOUBLED
v2  printed the anchored phrase, explaining the anchor -> report matched again
v3  printed "hooks]" while saying to anchor on it      -> partial pattern, matched again
```

**Measured: 31 matches against 25 real dispatches over two hours, the six extra being reports.**

> **Any literal printed in a log line is, by construction, inside the corpus a reader greps. The
> only stable fix is to print none.** The report now points here instead, and this file is not in
> that corpus.

**So: do not move this command back into the log line, however convenient it looks.**

### Validity conditions — both required

**1. Compare at the REPORT'S OWN timestamp, not at now.** Reports print at `events <= 5` then every
25, so a report can be an hour old while the host count is current. **A stale comparison manufactures
a shortfall that does not exist** — see §9.2a of `SPEC-outbound-message-id.md`.

**2. Verify against the live journal after any change to the report text.** That is how v2 and v3
were caught; **nothing else has worked.** Rendering the line and grepping it with every pattern a
reader might plausibly use is the check — the artifact, not the intent.

---

## 3. Deploy

**The prod clone has NO git remote** (`git remote -v` is empty), so `git pull` does not work there.
Deploy is bundle + ff-merge, per the deploy-from-git-only rule. **Never rsync or scp over the
tracked tree.**

```bash
# On the Mac, from the plugin dir
git bundle create /tmp/vc-plugin-outbound-id.bundle 2a41ac6..HEAD
scp /tmp/vc-plugin-outbound-id.bundle root@45.33.74.201:/tmp/

# On Linode
cd /root/.openclaw/extensions/virtual-context
git status --short                       # BLOCKER if tracked files are dirty
git fetch /tmp/vc-plugin-outbound-id.bundle HEAD:refs/remotes/bundle/main
git merge --ff-only refs/remotes/bundle/main
git rev-parse --short HEAD               # expect the pushed head
git status --short                       # tree must equal the commit
node --check index.js                    # gateway refuses to load on a parse error
```

Then edit the config (step 2) and restart:

```bash
systemctl --user restart openclaw-gateway
openclaw gateway status                  # Runtime: running, RPC probe: ok
```

---

## 4. What to look for — and the positive control

**At boot**, two new lines:

```
[vc:outbound-id] enabled mode=observe latePath=NOT configured convIdentity=stable
[vc:outbound-id] queue inventory - NO DIRECTORIES ON DISK (configured_scopes=2) ...
```

Absence of the first line means the config key did not take — check for a schema rejection, since
`additionalProperties: false` will refuse an unknown key outright.

**On the first outbound message**, the report prints immediately (not on a timer) — that firing is
the **positive control**. Until it has appeared, *"no ids captured"* and *"the hook is broken or
never reached"* are the same observation, and the report says so in its own text.

```bash
ssh root@45.33.74.201 'journalctl --user -u openclaw-gateway --no-pager --since "10 min ago" \
  -o cat | grep "vc:outbound-id"'
```

### 4.1 Reading the report

The measurements Phase A exists to produce, none of which are currently known:

| Field | Question it answers |
|---|---|
| `events` | Does `message_sent` fire at all here? |
| `withMessageId` / `withSessionKey` | Confirms §2.3's field table against live traffic |
| `withRunId` | **Should be 0.** Non-zero means the SDK's "not plumbed" doc is stale and §2.2 is wrong — report loudly. |

> **SCOPE GUARD (2026-08-21).** `withRunId` is the **outbound** hook's `event.runId`. Measured 0,
> which is correct. **It is NOT evidence about `ctx.runId` on the turn path**, which is populated —
> a generalisation from this row to that field produced a false structural claim that had to be
> retracted. See `SPEC-outbound-message-id.md` §10.3.0.
| `witnessed` vs `refused[...]` | Which populations are actually covered |
| `no_channel_ruler:telegram` | Size of the uncovered Telegram population |
| `multiChunkPayloads>=N` | Lower bound on the A9 hole |

### 4.2 What the numbers do NOT tell you

Printed in the report's own output, and repeated here so nobody reads a clean line as a clean result:

- **`capture_rate=UNKNOWN`.** `events` is a numerator with no denominator. This process cannot
  count how many deliveries occurred, so *"fired for every delivery"* and *"fired for one in a
  hundred"* look identical. **The denominator has to come from the gateway's own delivery log — a
  second, independent instrument.** Getting it is part of Phase A, not optional colour.
- **Ordering vs ingest is not reported at all.** `sessionKey` cannot disambiguate concurrent turns,
  so any ordering claim built on it would pair an outbound event with a turn it may not belong to.
- A zero in Telegram, multi-chunk, or `convIdentity: "session"` is **UNCOVERED**, never negative
  evidence.

---

## 5. Rollback

Remove the `outboundIdCapture` key and restart. There is no persistent state to clean up in observe
mode: nothing is written to disk and nothing was sent. Rollback is total.

---

## 6. Exit criteria — Phase A is done when

1. The hook has fired at least once in production (**positive control satisfied**).
2. The §2.3 field-presence table is restated **from measurement, with its N**, replacing static
   analysis — or §2 is rewritten loudly if the two disagree.
3. `withRunId` is confirmed 0, or §2.2 is retracted.
4. A delivery denominator exists from the gateway log, so `capture_rate` can stop being UNKNOWN.
5. The relative ordering of `message_sent` against `agent_end` is characterised — which decides
   whether the fast path or the late path carries the traffic, the thing §4.2 explicitly refuses to
   guess.
