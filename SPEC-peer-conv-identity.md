# Spec: Stable peer-keyed conversation identity for the Virtual Context OpenClaw plugin

**Status:** DRAFT v3 — cloud review + core engine acks folded (2026-06-10); codex architectural pass folded (2026-06-10)
**Owner:** openclaw@vc (plugin side); migration execution shared with cloud@vc
**Plugin:** `openclaw-plugin-virtual-context` (current 5.1.2, Linode production copy is source of truth)

---

## 1. Problem

The plugin identifies the VC cloud conversation with `vcconv = ctx.sessionId` — the OpenClaw
session JSONL UUID (`buildUrl`, index.js:144-147; used at prepare index.js:436, ingest
index.js:586, tool calls index.js:323).

OpenClaw session IDs rotate: `context_length_exceeded` reset (the only configured reset
trigger for direct chats on this deployment), `/new`, group idle reset (2880 min), manual
resets. Every rotation mints a fresh VC conversation, detaching the chat from all prior
VC memory. Production consequence (verified 2026-06-10): the Telegram DM peer
`telegram:direct:8049932331` has spanned 15+ session UUIDs since February; the VC cloud
holds 53 sibling conversations (49 unlabeled silos + 1 labeled group conv + 3 zero-turn e2e merge-test artifacts) for what the user perceives as ONE ongoing chat.
The 2026-05-14 failed recall (conv `f5bf0c29` asking about content that lived in
`77f110fc`/`a56e477b`) is this defect, observed in production with VC fully operational.

The fix: derive the VC conversation ID from the **stable session key** (the chat scope)
instead of the rotating session UUID, with a migration path for existing silo
conversations.

## 2. Current behavior (verified against index.js @ 5.1.2)

| Call site | Line | vcconv value today |
|---|---|---|
| `POST /api/v1/context/prepare` | 436 | `ctx.sessionId` |
| `POST /api/v1/context/ingest` | 586 | `ctx.sessionId` |
| `POST /api/v1/tools/{name}` | 323 | `ctx.sessionId` (tool factory ctx) |
| Ingest tracker (`initialized-sessions.json`) | 45-67 | keyed by `sessionId` |

Hook context availability (verified in source):
- `before_prompt_build`: `ctx.sessionId` + `ctx.sessionKey` ✔
- `agent_end`: `ctx.sessionId` + `ctx.sessionKey` ✔
- tool factory `(ctx) => tool`: `ctx.sessionId` ✔ AND `ctx.sessionKey` ✔ — verified in the
  production gateway dist (2026.4.23, Linode): `resolveOpenClawPluginToolInputs` in
  `dist/openclaw-tools-0ftkmYS3.js` builds the factory context with
  `sessionKey: options?.agentSessionKey` and `sessionId: options?.sessionId` (plus
  `agentId`, `messageChannel`, `agentAccountId`, `deliveryContext`). Both fields are
  optional-chained, and at least one other caller (`server-methods` `resolvePluginTools`
  call, `context: toolContext`) passes a differently-shaped context — so the derivation
  MUST null-guard `ctx.sessionKey` and fall back to ephemeral (`sessionId`) when absent.

Observed sessionKey shapes on the production deployment (bastkid-dedicated store):

```
agent:bastkid-dedicated:main
agent:bastkid-dedicated:telegram:direct:8049932331
agent:bastkid-dedicated:telegram:group:-5156869263
agent:bastkid-dedicated:telegram:slash:8049932331
agent:bastkid-dedicated:discord:channel:1485708353660260422
agent:bastkid-dedicated:cron:<jobUuid>                       (store form)
agent:bastkid-dedicated:cron:<jobUuid>:run:<runUuid>         (journal/diagnostic form)
agent:bastkid-dedicated:subagent:<spawnUuid>
```

## 3. Proposed conversation identity

### 3.1 Derivation function

New exported pure helper (testable, same pattern as `selectPrepareTimeout`/`buildUrl`), returning metadata because the caller needs to decide whether to send `predecessor` and whether to emit a counted fallback warning:

```js
export function deriveConvIdentity(sessionKey, sessionId) -> {
  convId: string,
  isStable: boolean,
  fallbackReason?: "subagent" | "cron" | "missing_session_key" | "unparseable_session_key"
}
```

Rules, applied to `sessionKey` only when `convIdentity === "stable"`; in `session` mode the plugin bypasses derivation and uses `ctx.sessionId` exactly as today:

| Scope pattern | Stable? | vcconv value |
|---|---|---|
| `agent:<agentId>:telegram:direct:<peer>` | yes | `sk:` + sessionKey |
| `agent:<agentId>:telegram:group:<id>` | yes | `sk:` + sessionKey |
| `agent:<agentId>:telegram:slash:<peer>` | yes | `sk:` + sessionKey |
| `agent:<agentId>:discord:channel:<id>` | yes | `sk:` + sessionKey |
| `agent:<agentId>:main` | yes | `sk:` + sessionKey |
| `agent:<agentId>:cron:<jobUuid>[:run:<runUuid>]` | no (D1 closed: ephemeral) | `sessionId` (unchanged), no warning |
| `agent:<agentId>:subagent:<spawnUuid>` | no (ephemeral by nature) | `sessionId` (unchanged), no warning |
| `agent:<agentId>:explicit:<sessionId>` | no (disposable/probe sessions, `openclaw agent --session-id`) | `sessionId` (unchanged), no warning |
| empty / unparseable sessionKey | no | `sessionId` (unchanged) + `[vc] warn` log **with a per-boot counter** |

The warn-counter matters (cloud review): an ephemeral fallback is a silent
re-introduction of the per-UUID churn defect for that scope. A systematically-missing
`sessionKey` (e.g. the differently-shaped `server-methods` caller context in §2) must
show up in ops via repeated counted warnings, not silently revert a channel.
The pure helper returns `fallbackReason`; the register-scope call-site wrapper owns the
per-boot counter and logs only missing/unparseable fallbacks, not intentional subagent
ephemeral routing.

- The `sk:` prefix disambiguates stable-keyed conv IDs from legacy UUID conv IDs on the
  cloud side (legacy IDs are bare UUIDs; no collision is possible, but the prefix makes
  intent greppable in logs and lets the cloud route migration logic without heuristics).
- The raw sessionKey is used verbatim (after the cron run-suffix stripping above) —
  human-readable, collision-free per agent+scope, already URL-safe via the existing
  `encodeURIComponent` in `buildUrl` (colons encode to `%3A`). `buildUrl` must also
  encode the new `predecessor` query value, even though today's session UUIDs are already
  URL-safe.
- Case sensitivity is intentional: preserve the agent id and the whole sessionKey exactly
  as received; do not lowercase or normalize. The structural tokens in the table are
  matched as lowercase OpenClaw tokens. An unknown case variant is unparseable fallback,
  not a best-effort stable id.
- Multi-agent collision avoidance depends on retaining the leading `agent:<agentId>:`
  namespace. Do not strip agent id, account id, or channel scope to "simplify" IDs; two
  agents can share the same Telegram peer/channel id and must still get separate VC convs.
- Do not wildcard all `agent:<agentId>:<platform>:<scope>:...` shapes into stable IDs.
  New stable scope families require an explicit table row and unit test; unknown shapes
  fall back to ephemeral with a counted warning.
- **D1 CLOSED (user, 2026-06-11): crons are EPHEMERAL.** Cron traffic intentionally runs
  on a model outside the VC provider allowlist, so prepare/ingest never fire for crons
  regardless of identity scheme — stable per-job identity would be dead config. Cron
  scopes are recognized (both store and `:run:`-suffixed forms) as intentional ephemeral,
  no warning. If cron models ever move inside the allowlist, revisit.
- **D2 CLOSED (user, 2026-06-11, as recommended): subagents EPHEMERAL** — spawn UUIDs are meaningless
  as identity; merging all subagent runs of an agent into one conv would interleave
  unrelated tasks. Keep ephemeral.

### 3.2 Call-site changes

All three vcconv call sites switch from `sessionId` to the selected conversation id:
prepare (index.js:436), ingest (index.js:586), and tool calls (index.js:323). The current
`vcPost(baseUrl, path, vcKey, sessionId, ...)` / `buildUrl(..., sessionId)` parameter names
should be renamed to `convId` in the implementation and tests, because after this change
the value is no longer necessarily the OpenClaw session UUID.

The tool-call site does **not** need the stale OPEN-1 reverse lookup. Tool factory ctx has
`sessionKey` in the production gateway dist (§2). If a differently-shaped caller omits it,
`deriveConvIdentity("", sessionId)` returns the ephemeral session id and the stable-mode
call site emits a counted warning; tools continue to work scoped to the session.

Prepare is the only path that sends `predecessor`, and only when all are true:
`convIdentity === "stable"`, `identity.isStable === true`, and `identity.convId !== sessionId`.
Ingest and tool calls use the same `vcconv` but never send `predecessor`.
Extend `buildUrl` with an options object (for example `{ predecessor }`) rather than
overloading positional arguments; append the encoded `predecessor` param after encoded
`vcconv` when present.

The ingest tracker (`initialized-sessions.json`) stays **sessionId-keyed, unchanged**:
bulk-ingest reads one session's JSONL file; a new session under the same stable conv
must still bulk-ingest its own (new) JSONL exactly once. `VCREINGEST` semantics unchanged.

`vcCommandSessions` also stays **sessionId-keyed**. It is a per-lifecycle-turn ingest-skip
guard, not a conversation identity cache. Keying it by stable conv id would let a VC command
in one session/run suppress ingest for another concurrent session/run that shares the same
stable conv (notably cron-per-job and any same-peer overlap). Under stable identity:
`VCREINGEST` resets the tracker for the current `sessionId`; the next normal prepare
re-sends that current session JSONL to the currently selected VC conv. It does not re-ingest
historical sibling silos; those remain manifest/VCMERGE work.

### 3.3 Config gate + rollback

New config key (additive, `configSchema` updated; `additionalProperties: false` requires
the schema change to ship in the same version):

```json
"convIdentity": { "type": "string", "enum": ["session", "stable"], "default": "session" }
```

- Default `"session"` = exact current behavior; the release is a no-op until the
  deployment flips the flag. This separates code rollout from behavior rollout.
- Rollback = set `"session"` + gateway restart. Sessions resume per-UUID convs; the
  stable convs remain intact on the cloud (no destructive transition in either direction).
- Runtime handling should be defensive even with schema validation: any value other than
  literal `"stable"` behaves as `"session"` and logs a config warning once at register.
- In `"session"` mode, do not call the stable derivation wrapper, do not increment the
  fallback warn-counter, and never send `predecessor`. This matters during rollback: the
  first post-rollback prepare must be byte-equivalent to today's URL shape except for any
  unrelated debug logging improvements.

## 4. Migration of existing silo conversations

Two distinct populations, two mechanisms:

### 4.1 Forward link (automatic, per-chat, at first stable prepare)

On the first prepare a chat makes under `convIdentity=stable`, the cloud sees the stable
conv id (`sk:...`). Depending on the target-blind tracker decision in §4.1.1/§5.1, that
prepare either replays the current session's full JSONL through the normal initial-ingest
path or continues windowed and relies on the predecessor link for existing session-era
content. To link the current session-era silo for the same OpenClaw `sessionId`, the
plugin sends the predecessor id
**as a query parameter** (cloud review 2026-06-10), added in `buildUrl` next to
`vckey`/`vcconv`, only when the selected identity is stable and differs from `sessionId`:

```
POST /api/v1/context/prepare?vckey=...&vcconv=sk%3A...&predecessor=<encoded ctx.sessionId>
```

**Why a query param, not a body field:** cloud's `rest_prepare` passes the parsed body
wholesale to engine `prepare_payload` (rest_api.py:182-186) and the engine deep-copies
the body into the returned provider payload (proxy/server.py:1488; passthrough returns
`body` itself). A top-level body field would round-trip INTO the LLM provider request,
which providers reject as an unknown param. A query param keeps the LLM payload
byte-clean by construction and never depends on cloud remembering to strip it.
(Body-field alternative is acceptable ONLY with a mandatory cloud-side pop in
`rest_prepare` before `prepare_payload` — rejected here as a standing footgun.)

Contract status: ACCEPTED by cloud + core (2026-06-10). Field name
`predecessor_conversation_id` is the accepted contract name; on the query-param
transport chosen here it travels as `predecessor` (same semantics). Engine surface:
`link_predecessor(predecessor_id, stable_id)` with a four-branch decision tree —
(i) same terminal -> no-op; (ii) predecessor already aliased elsewhere -> conflict
reported in response metadata, NO write, prepare still succeeds; (iii) stable conv
empty + predecessor has data (the common first-flip case) -> alias STABLE->PREDECESSOR
(direction is the engine's; an alias is a routing redirect, so this is the direction
that makes stable-conv retrieval reach the predecessor's stored turns); (iv) both
sides have data -> no inline action, `needs_merge` surfaced in metadata, the manifest/
VCMERGE track executes it. The plugin stays direction-agnostic: it only guarantees the
HINT; linkage mechanism and direction are engine semantics.

Semantics details:
- Sent on **every** stable prepare — idempotent hint, no plugin-side state machine.
  Cloud's reservation machinery already makes replays no-ops (`committed_match`,
  merge_handler.py:394-396); steady-state cost ≈ one indexed lookup.
- **Conflict policy: first-write-wins + refuse-and-report.** If the same predecessor
  arrives for a DIFFERENT stable conv, the second link is refused
  (`committed_mismatch` shape, merge_handler.py:398-405) and surfaced in the prepare
  response `metadata` — NEVER as an HTTP error. A memory-link failure must not break
  chat traffic; the prepare itself always proceeds.
- Until the engine surface ships (implementation committed but gated on the user
  green-lighting this track), cloud logs + no-ops the param; the plugin behavior is
  identical either way (fire-and-forget hint).
- Engine-side note (core ack): today's alias-store upsert is last-write-wins; the
  first-write-wins/never-repoint guard lives in the NEW `link_predecessor` surface.
  Nothing for the plugin to do.

#### 4.1.1 Tracker note

The current sessionId is typically already in
`initialized-sessions.json` from the session-era. The tracker value does not record which
VC conv received the JSONL (index.js:45-67 stores only `{ ingestedAt, messages }` under
`sessionId`), so any identity-mode transition can make a tracker entry stale relative to
the newly selected conv id.

The current tracker is target-blind: archive/clear is only a manual replay lever, not a
namespace-aware migration. For `session` → `stable` with `link_predecessor` live, the
preferred no-loss/no-duplicate transition is to archive the file for rollback visibility
but preserve existing entries; already-ingested live sessions continue through the
predecessor link, while fresh post-flip `sessionId`s have no entry and bulk-ingest normally
into the stable id. Clear selected entries only when full JSONL replay into the new
terminal is intentionally desired and duplicate replay is acceptable/idempotent. The same
rule applies on rollback: preserving entries means windowed continuation; clearing an entry
rehydrates that per-UUID conv but may replay turns it already contains. Deploy runbook
covers the manual choice; automatic target-aware replay would require a tracker schema/code
change and is out of scope for this spec.

### 4.2 Historical silos (one-time, manifest-driven, cloud-executed)

The forward link only reaches the CURRENT predecessor. The ~49 unlabeled silos, the 5
transcription convs (`a56e477b`, `f5bf0c29`, `1c2838cc`, `619d2a73`, `fc5fd047`), and the
`77f110fc` group lineage are historical and unreachable from any live session pointer.

- **Plugin-side deliverable (mine):** a migration manifest mapping
  `old conv id (sessionId)` → `stable conv id (sk:...)`, built from Linode session JSONLs
  + store history. DRAFT BUILT: `/root/vc-migration/manifest-draft.json` (249 rows,
  generator `/root/vc-migration/build_manifest.py`). Binding sources, in confidence
  order: (1) `store-verified` — sessionId bound to a scope key in `sessions.json` or a
  dated store snapshot; (2) `chatid-verified` — the session's
  `custom_message`/`openclaw.runtime-context` records carry a literal `chat_id`
  (runtime-injected metadata, near-store-grade; present in recent-era JSONLs);
  (3) `ambiguous`/`none` — no marker (mostly March-era sessions predating the
  runtime-context records, plus ~150 small cron-run sessions of ≤10 messages).
  Draft tally: 18 DM, 13 group, 6 main, 9 cron/subagent, 1 discord, 202 unknown
  (only 52 of the unknowns exceed 10 messages; the large ones are March-era).
  The executor migrates ONLY `store-verified`/`chatid-verified` rows; unknowns stay
  unmigrated (still reachable via `vc_find_session` date queries) pending optional
  later binding. Checkpoint files are recorded as lineage members of their
  `base_session` and inherit its binding.
- **Cloud-side execution (theirs) — merge vs alias is NOT a free choice** (cloud review
  2026-06-10; the two have opposite data semantics):
  - **ALIAS** = routing redirect only; the alias_id's own pre-existing rows do NOT move.
  - **MERGE** = moves data into the target (`origin_conversation_id` stamped across
    canonical_turns/segments/tag_summaries/facts; source marked phase='merged').
  - Therefore: **historical silos (the unlabeled convs + 5 transcription convs) get
    MERGE** — aliasing them would only redirect future traffic to ids nothing will ever
    address again, leaving the content siloed (defect survives). Execution path:
    `?vcconv=<old_id>` + `VCMERGE INTO <stable_id>` via the existing REST intercept
    (rest_api.py:215-222). All silos are under the 10000-turn sync limit (largest:
    `6f0b3f13` at 3084 turns) — no async path needed.
  - **EXCLUDE** the 3 `e2e-*` merge-test artifacts (phase='merged', 0 turns) from the
    manifest. Precise silo count cloud-side: 53 total = 1 labeled group conv + 3 e2e
    artifacts + 49 unlabeled.
- **`77f110fc` continuity (hard requirement) — reverse ALIAS, not merge:** don't move
  4849 turns / 369 segments / 1724 tag_summaries / 872 facts into an empty new conv.
  Instead create the stable group id (`sk:...group:-5156869263`) as an **alias pointing
  AT `77f110fc`** — the lineage data stays in place; the stable id's traffic routes to
  where everything already lives (same mechanism as the 15 existing alias_ids). §7
  acceptance holds because retrieval IS `77f110fc`.
- **ORDERING CONSTRAINT (hard):** the group alias must exist **BEFORE** the
  `convIdentity` flag flips — otherwise the first group prepare creates
  `sk:...group:...` as a real conv with its own turns, minting a NEW alias+data
  dual-existence anomaly (the exact shape this project is trying to stop producing).
  Deploy sequence: **create group alias → flip flag → run manifest.** Core CONFIRMED
  from engine code (proxy/vcattach.py:174-182) that VCATTACH is a durable redirect, not
  a merge, with NO guard refusing an attach when the attaching conv already has data —
  flip-first would strand the sk-group conv's early turns exactly like `db12d44d`.
  Remediation if the ordering is ever violated: VCMERGE the stranded turns into the
  lineage; do NOT re-attach.
- **Target-existence prerequisite:** cloud's `_resolve_target_id` only resolves convs in
  the tenant's persisted list (merge_handler.py:132-160) — each `sk:` target must EXIST
  before its manifest rows execute. The flag flip + first organic prepares create them;
  the executor pre-creates any stragglers via a prepare call.
- **Kill-switch:** VCMERGE INTO has an emergency-disable gate that fail-closes with 503
  (merge_handler.py:72-80). The executor treats 503 as HALT-AND-SURFACE, never
  retry-forever.
- **Constraints from known alias anomalies** (`db12d44d`/`908ce992` alias+conv dual
  existence; orphan alias `109f7fd0 → 4639cb58`): the migration must be (a) idempotent —
  re-running the manifest is a no-op; (b) refuse-and-report — if an alias target conflicts
  with an existing conv/alias, skip that row and report it rather than overwrite. The
  anomaly CLEANUP itself is an explicitly separate engine/cloud track, out of scope here.

## 5. First-prepare behavior per existing channel (post-flip)

| Channel | First stable prepare does |
|---|---|
| Telegram DM | selected `vcconv=sk:...direct:8049932331`; `predecessor=<current DM sessionId>` query param; current JSONL bulk-ingests only for fresh post-flip sessions or entries intentionally cleared per §4.1.1/§5.1 |
| Telegram group | `vcconv=sk:...group:-5156869263` routes through the pre-created alias to `77f110fc`; `predecessor=<current group sessionId>` query param; current JSONL bulk-ingests into that lineage only for fresh post-flip sessions or entries intentionally cleared per §4.1.1/§5.1 |
| main / discord channel | same pattern |
| new webchat / channel scopes | only stable after an explicit §3.1 allow-list row + tests; otherwise ephemeral fallback |
| crons | unchanged (ephemeral; VC filtered off by model allowlist anyway) |
| subagents | unchanged (ephemeral) |

### 5.1 Deploy / rollback runbook

1. Ship plugin code and `openclaw.plugin.json` schema with default `convIdentity="session"`.
   Confirm register logs show the resolved mode; default rollout must be a no-op.
2. Confirm cloud/core prerequisites are live or intentionally no-op-safe: `sk:` reserved
   namespace, `predecessor` query parsing, `link_predecessor`, merge conflict metadata,
   and VCMERGE kill-switch behavior.
3. Before the flag flip, create the group alias
   `sk:agent:bastkid-dedicated:telegram:group:-5156869263 -> 77f110fc`. Verify retrieval
   through the stable id before any organic group prepare can create a real `sk:` conv.
4. Immediately before `session` → `stable`, snapshot the ingest tracker:
   `~/.openclaw/extensions/virtual-context/initialized-sessions.json`. With
   `link_predecessor` live, preserve existing entries by default so already-ingested live
   sessions link forward without replaying their full JSONL into an alias/predecessor
   terminal that may already contain those turns. Clear only specific entries whose full
   replay is intentionally desired and duplicate-safe. Fresh post-flip sessions have no
   tracker entry and bulk-ingest normally into their stable ids.
5. Set `convIdentity="stable"` and restart the gateway. Verify prepare, ingest, and tool
   calls all carry the same encoded stable `vcconv`, and prepare carries encoded
   `predecessor=<current sessionId>` only on stable identities.
6. Run DM and group smoke checks before the manifest: DM should create/use its `sk:`
   conv; group should route to `77f110fc` through the alias. Monitor counted fallback
   warnings and predecessor conflict metadata.
7. Execute the historical manifest after the flip. Pre-create any stable targets that
   have not yet appeared organically; exclude the 3 e2e artifacts; halt on VCMERGE 503.
8. Rollback: set `convIdentity="session"` and restart. Post-rollback prepare URLs must
   omit `predecessor` and use bare `sessionId` vcconv. Preserve tracker entries when
   windowed rollback is acceptable. If rollback needs full JSONL hydration of resumed
   per-UUID convs, clear the selected entries after snapshotting the file; that replays the
   whole JSONL and can duplicate turns already present in those per-UUID convs unless the
   cloud path is idempotent for that replay.
9. Re-flip after rollback follows the same transition rule: do not recreate the group
   alias if it already exists; snapshot the target-blind tracker, preserve by default, and
   clear only entries whose replay is intentional and duplicate-safe; then verify URLs and
   smoke checks before running any manifest rows.

## 6. Failure modes & mitigations

| Failure | Behavior |
|---|---|
| Cloud ignores `predecessor` query param | Stable ids and new turns still work, but existing session-era recall is lost unless ops chose duplicate-safe JSONL replay for that entry; otherwise recover through manifest/VCMERGE |
| `sessionKey` empty/unparseable in stable mode | Ephemeral fallback (current behavior), counted warning every fallback with per-boot counter; no warning in `session` mode |
| Tool factory lacks sessionKey despite OPEN-1 resolution | Tool call scoped to sessionId conv via null-guard fallback — degraded recall for that call, no error, counted warning in stable mode |
| Mixed state: plugin flipped, historical manifest not yet run | Stable convs accumulate NEW turns correctly; current predecessor-era recall follows `link_predecessor`/selective replay behavior, while historical non-current silos remain unreachable until the manifest executes. Acceptable interim per deployment owner |
| Flip back to `session` after stable era | Per-UUID convs resume; stable convs dormant but intact; no `predecessor`; preserving tracker gives windowed continuation, while clearing selected entries gives full JSONL replay with duplicate risk unless cloud replay is idempotent |
| Double-flip flapping | No destructive data loss either direction, but every identity-mode transition changes the target conv namespace and needs an explicit tracker decision: preserve for no-replay continuity, clear only for intentional duplicate-safe replay |
| `VCREINGEST` under stable identity | Resets only the current `sessionId` tracker entry; next normal prepare sends that session JSONL to the active stable conv; historical siblings are unaffected |
| VC command skip state under stable identity | `vcCommandSessions` remains `sessionId`-keyed so command turns suppress only their own `agent_end`, not other sessions sharing the same stable conv |

## 7. Test plan

Per `feedback_verify_routing_read_path`: both WRITE and READ-through-routing halves,
prod-replay, not just unit fixtures.

1. **Unit (vitest, extends existing harness):** `deriveConvIdentity` table — every scope
   shape in §3.1 including `telegram:slash`, cron store and `:run:` forms, subagent
   intentional-ephemeral, empty/unparseable fallbacks, uppercase agent-id preservation,
   lowercase structural-token matching, `sk:` prefixing, and no wildcarding unknown scopes.
2. **URL/config units:** `buildUrl` encoding of colon-bearing conv ids and encoded
   `predecessor`; prepare URL carries `predecessor` iff stable∧differs; no predecessor on
   ingest/tools, subagent fallback, missing sessionKey fallback, or `convIdentity=session`.
   `openclaw.plugin.json` schema exposes `convIdentity`; runtime default and invalid values
   resolve to session mode.
3. **Hook integration units:** fake `api.registerTool`/`api.on` harness proves prepare,
   ingest, and tool calls use the same selected conv id; debug logs print selected `convId`
   rather than stale `sessionId`; provider filtering still reads `sessionKey` for
   `resolveSessionModel`.
4. **Tracker/command units:** tracker remains keyed by `sessionId`; two different
   sessionIds with one stable conv each get one JSONL initial ingest; `VCREINGEST` resets
   only the current sessionId and next stable prepare sends full JSONL to the stable conv;
   VC-command skip state remains sessionId-keyed and does not suppress another session
   sharing the same stable conv. Transition tests cover both tracker-preserved
   predecessor-link behavior and intentionally-cleared replay behavior.
5. **Warning/rollback units:** stable-mode missing/unparseable sessionKey increments the
   per-boot warning counter; session mode does not derive, warn, or send predecessor;
   stable→session rollback restores bare sessionId URL shape.
6. **Prod-replay WRITE:** flip on Linode (or staging key), send a real DM turn, verify
   journal `[vc:wire] POST .../prepare ... vcconv=sk%3Aagent%3A...` + ingest same conv id
   + cloud dashboard shows the stable conv accruing.
7. **Prod-replay READ:** force a session rotation (`/new`), send a recall question about
   pre-rotation content, verify the answer reaches it (tool call carries the SAME stable
   vcconv across the rotation). This is the defect's reproduction inverted — the
   closure criterion.
8. **77f110fc acceptance:** before flag flip, stable group id routes to `77f110fc`; after
   flag flip, `vc_find_quote` from the live group session for a known 77f110fc-era fact
   returns it.
9. **Temporal-ordering regression** (per `feedback_regression_both_temporal_orderings`):
   exercise both already-running-session-at-flip and fresh-session-after-flip, with the
   tracker snapshot/preserve default and explicit-clear replay path covered before each
   namespace transition.

## 8. Out of scope

- Engine/cloud implementation of predecessor aliasing and manifest merge execution.
- Alias-anomaly cleanup (`db12d44d`, `908ce992`, `109f7fd0`).
- The codex-OAuth / model-fallback restoration (separate live-ops track).
- New platform/scope families beyond observed shapes. Multi-agent uniqueness for observed
  shapes is in scope and comes from preserving `agent:<agentId>:` in the stable id.

## 9. Open items

- ~~**OPEN-1**~~ RESOLVED — tool-factory ctx DOES expose `sessionKey` (verified in
  gateway 2026.4.23 dist, see §2). Reverse-lookup helper NOT needed; null-guard +
  ephemeral fallback retained for differently-shaped caller contexts.
- ~~**OPEN-2**~~ RESOLVED (2026-06-10, cloud + core): predecessor contract accepted
  (`link_predecessor` decision tree, conflict guard in the new surface, VCATTACH
  redirect-not-merge confirmed -> alias-before-flip ordering stands). Additionally
  `sk:` becomes a DOCUMENTED RESERVED NAMESPACE passed verbatim on EVERY path —
  core changes `resolve_conversation_id` so `sk:`-prefixed explicit ids return
  verbatim before UUID parsing, without the format_name salt; proxy and REST
  transports converge (no REST-only fork). Manifest freezes on literal `sk:` strings.
  Engine implementation is decision-final but ships after the user green-lights the
  stable-conv-identity track.
- **D1/D2 decisions** (§3.1): cron stable-per-job (recommended), subagent ephemeral
  (recommended) — deployment owner sign-off.
- **OPEN-3:** version/compat — this is additive plugin behavior; minor version bump
  (5.2.0) + manifest version sync per the existing release discipline.
