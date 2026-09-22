# SPEC: OpenClaw proxy mode (VC owns the model payload)

Status: v4, 2026-09-21. v1 to v3 refuted; v4 changes the switch to a per-agent twin (the host
gives `before_model_resolve` no provider or model), makes VC terminal for enabled agents (no
native fallback after selection), and makes the signed route id authoritative in the cloud.
Scope: plugin (this repo), cloud (`vc_cloud`), OpenClaw config on the gateway box. Engine: none.

## 1. Problem

On OpenClaw 2026.9.3 the plugin cannot control the payload the model receives (hooks are
additive; the context engine controls only the first-call assembled history). Measured on a
Vast Discord turn: 142,561 input tokens, VC's block about 15K. In proxy mode VC owns the
outbound request for every model call, tool continuations included.

## 2. Verified host facts (gateway box, OpenClaw 2026.9.3, codex-cli 0.153.4, 2026-09-21)

1. SDK transport `openai-chatgpt-responses` works on the Codex subscription (200 from
   `chatgpt.com/backend-api/codex/responses` for gpt-6-astra and gpt-5.6-sol).
2. A catalog entry on provider `openai` may carry `baseUrl` and `headers`; a twin with a
   custom `baseUrl` POSTed `<baseUrl>/codex/responses` with the OAuth Bearer and body
   `{input, model: "<twin id>", store, stream, max_output_tokens}`; no `previous_response_id`.
3. Any provider id other than `openai` gets no OAuth. `modelOverride` is the switch.
4. `resolveEmbeddedRunModelSetup` calls `resolveHookModelSelection({prompt, attachments,
   provider, modelId, modelSelectionLocked, hookContext})`; the hook receives only
   `{prompt, attachments}` and `hookContext`, and no `hookContext` literal in the worker
   carries `modelId` or `modelProviderId`. When `modelSelectionLocked` is true the hook is not
   called. The override result is logged `[hooks] model overridden to <id>`.
5. OpenAI-provider models resolve implicitly to the `codex` app-server runtime unless the agent
   sets `agentRuntime.id`; `openclaw` selects the embedded runner (SDK transport). Our context
   engine returns the full host history there.
6. `composeCliPromptContext` places `prependContext` at the head of the composed prompt; the
   host may apply `applyPluginTextReplacements`. Placement inside Responses `input` items is
   proven from captured bodies in §5.0.
7. Cloud `TenantMiddleware` rewrites only `request.scope["path"]` when stripping `/vc-<key>/`;
   `request.url.path` stays prefixed. It keeps the plaintext key on `request.state.api_key`,
   forwards `Authorization` untouched, chooses the upstream before the strip, and turns
   `?vcconv=`/`?predecessor=` into state. The engine strips its own assistant markers, then
   calls the cloud resolver with the body dict it keeps using; the resolver's legacy path
   prefers a previous assistant `vc:conversation` marker when the explicit id is unknown.
8. Engine `_VC_CONVERSATION_RE` matches only `<!-- vc:conversation=... -->`, assistant items
   only for Responses bodies. Canonical-turn dedup hashes normalized user plus assistant text.
9. Plugin: `hookSessionIdentity(ctx)` = `sessionId ?? sessionKey ?? "unknown"`;
   `hookInvocationRunId` fails closed on group sessions without `runId`; the `llm_input`
   handler derives `sessionId ?? "unknown"` and `runId ?? sessionId`; `agent_end` uses
   `hookInvocationRunId` and `event.runId`. The durable completion outbox exists for
   exact-admission channels only; other channels ingest best effort.

## 3. Guarantee

For an enabled agent, every model attempt of a run whose selection latch was taken goes to VC
with the complete `input` the host assembled; the cloud resolves each such attempt to the
plugin's `sk:` conversation from the signed route marker or rejects the attempt with 422, never
another conversation; the turn is ingested by the proxy only. If VC is unavailable for such an
attempt the run fails visibly (no native fallback for enabled agents). A run for which no
latch was taken (§4.1 bypass reasons) runs the native model on the embedded runner and is
ingested by the plugin's existing path, whose durability is unchanged by this spec. The plugin
adds no synchronous network wait to model resolution.

## 4. Design

### 4.1 Switch (plugin, `before_model_resolve`)

```json
"proxyMode": {
  "enabled": true,
  "agents": { "bastkid-dedicated": "gpt-6-astra-vc" },
  "healthTimeoutMs": 1500,
  "healthTtlMs": 60000,
  "latchTtlMs": 600000
}
```

`proxyLatchKey(ctx)` = `(ctx.sessionKey || ctx.sessionId) + "|" + ctx.runId`; empty when
either part is missing. The same function is used by every hook below.

Return `{ modelOverride: <agent twin> }` only when ALL hold; otherwise return nothing and log
`[vc:proxy] bypass agent=<id> reason=<...>` once per latch key:

- the agent is enabled and passed startup validation (§4.5);
- `proxyLatchKey(ctx)` is non-empty (`reason=no-run-key`);
- the session is marked ingested by the existing initial-history path
  (`reason=initial-ingest-pending`);
- cached health is `ok` (`reason=health`). Health refresh is background only: when the cache
  is older than `healthTtlMs`, start `GET <pluginBaseUrl>/vc-<agent key>/dashboard/settings`
  bounded by `healthTimeoutMs`; decide from the current cached value; unknown is not ok.

On selection, latch `{twin, convId, sig, at}` under the latch key. `convId` comes from the
existing `deriveConvIdentity` for the session; if it is not stable (`sk:`), bypass
(`reason=unstable-identity`). Latches expire after `latchTtlMs`.

### 4.2 Route (OpenClaw config; operator step, validated at startup)

Twin entry under `models.providers.openai.models[]`, a copy of the real entry with only:
`id` = `<real>-vc`, `name`, `baseUrl` = `https://openai.virtual-context.com/vc-<agent key>/backend-api`,
`headers` = `{"X-VC-Upstream-Model": "<real>"}`. Enabled agents set
`agents.entries.<id>.agentRuntime.id = "openclaw"`, `model.primary` to any twinned real
model, and `model.fallbacks` to twins only (or empty).

### 4.3 Plugin behavior for a latched run

- Initial history: unchanged; the latch is never taken before the ingest mark exists.
- Context engine: unchanged pass-through (full history in `input`).
- `before_prompt_build`: latch present for `proxyLatchKey(ctx)` → no prepare, no message
  mutation; `prependContext` = `<!-- vc:route conversation=<convId> sig=<hex> -->` on its
  own line, then the existing current-speaker attribution when a group speaker applies.
  `sig` = `HMAC-SHA256(key = the agent's VC key, msg = "vc:route:" + convId)` first 32 hex.
  No latch → today's behavior.
- `llm_input`: latch present → log `[vc:proxy] attempt model=<event.model>` (observability
  only; ownership does not depend on it).
- `agent_end`: latch present → skip the plugin's ingest for this run (every attempt of the run
  went through VC by §4.2 and §4.5) and delete the latch in a `finally`; no latch → today's
  path. Latches also expire by TTL for runs that never reach `agent_end`.
- VC commands, speaker attribution, media labeling, continuity: unchanged.

### 4.4 Cloud

`TenantMiddleware.dispatch`:

1. Strip the tenant prefix and authenticate (as today); the rewritten path is
   `request.scope["path"]`.
2. Resolve upstream from the rewritten path: `/backend-api/...` → `https://chatgpt.com`
   (`PROVIDER_MAP["chatgpt"]`, any subdomain); else the subdomain rule.
3. `request.state.vc_twin_route = rewritten path == "/backend-api/codex/responses"`.
   Copy `X-VC-Upstream-Model` to `request.state.vc_upstream_model`; delete every `X-VC-*`
   header from `scope["headers"]`.

Cloud resolver (`_resolve_state`), when `request.state.vc_twin_route`:

4. Find every `<!-- vc:route conversation=<id> sig=<hex> -->` across the text blocks of the
   LAST user item of `input`. Require exactly one, `sk:`-prefixed, with a valid HMAC under
   `request.state.api_key`. Otherwise return 422
   `{"error": {"type": "vc_route_required", "reason": "missing|invalid_signature|ambiguous|not_sk"}}`
   before any engine or upstream work. `?vcconv=`/`?predecessor=` must be absent or equal to
   the signed id, else the same 422.
5. The signed id is authoritative: the resolver uses it directly as the conversation id and
   skips the assistant-marker, attach-alias, label, chat-id and system-hash logic entirely on
   this route (a missing conversation is created under the signed id, as any `sk:` id is).
6. Remove the marker text from that user item; if `request.state.vc_upstream_model` is set,
   replace `body["model"]` with it. Both happen on the body dict the engine keeps.

### 4.5 Startup validation (plugin `register`)

For each enabled agent: `agentRuntime.id === "openclaw"`; `model.primary` is `openai/<real>`
with a twin `<real>-vc` in the openai catalog; `model.fallbacks` entries are all
`openai/<x>-vc` twins present in the catalog; every referenced twin has
`api: openai-chatgpt-responses`, `baseUrl` exactly `https://<plugin baseUrl host>/vc-<the agent's key>/backend-api`
(https, no query, no fragment), `headers["X-VC-Upstream-Model"]` equal to its real id,
`cost` and `maxTokens` present. Any miss: `[vc:proxy] DISABLED agent=<id> reason=<...>`, agent
excluded from selection.

## 5. Validation (harnesses only), in order

0. Gate before enabling any agent: (a) a probe-agent run logs `proxyLatchKey` presence at
   `before_model_resolve`, `before_prompt_build`, `llm_input`, `agent_end` and their equality;
   (b) cloud request captures of twin calls show the marker as leading text of the last user
   item for a plain prompt, an image prompt, and a tool-calling run's continuation call.
   Failure of (a) means proxy mode cannot activate; failure of (b) for a shape is a 422 (loud)
   and a spec revision.
1. Plugin vitest: selection preconditions and bypass reasons; latch lifecycle incl. TTL and
   `finally` cleanup; one latch key across hooks; signed marker text; startup validation.
2. Cloud tests through the external `/vc-<key>/backend-api/codex/responses` URL: upstream
   rule; header copy and strip; twin-route flag from the rewritten scope; valid marker
   accepted, stripped, authoritative even when an assistant item carries a different
   `vc:conversation`; missing, bad-signature, ambiguous, non-`sk`, conflicting `vcconv`
   rejected with 422; model restored.
3. Route smoke on the box: `openclaw infer model run --local --model openai/gpt-6-astra-vc`
   → 200; capture shows `model` restored; log shows `Floor:` and `ASSEMBLE_BUDGET`; ledger row.
4. Agent path: `openclaw agent --agent bastkid-dedicated --session-key
   agent:bastkid-dedicated:probe-<stamp> -m "Reply with exactly: OK" --json`; gateway log shows
   `[hooks] model overridden to gpt-6-astra-vc`, cloud `Floor:` with outbound below inbound,
   `/dashboard/usage` incremented, one canonical turn.
5. Acceptance: one real bastkid session before and after, input tokens per turn from the ledger.

## 6. Rollout and rollback

bastkid-dedicated first, then Vast (embedded runner plus a `gpt-5.6-sol-vc` twin). Rollback:
`proxyMode.enabled=false` (next run) and restore the agent's fallbacks; removing
`agentRuntime` returns an agent to the app-server.

## 7. Residuals

- VC unavailable while enabled means failed runs for enabled agents (by design; health check
  bypasses ahead of time when VC is known down).
- A bypassed run whose native attempt fails may fall back into a twin and receive 422 (the
  run was already failing; the error is visible).
- VC forwarding an attempt and failing before persisting loses that proxy ingest, as in
  proxy mode today.
- `modelSelectionLocked` sessions never reach the hook and therefore always bypass.
- Native bypass runs keep the existing ingest path's durability (exact-admission channels
  durable, others best effort); this spec does not change it.


## 8. Implementation notes (2026-09-21, cloud 7f7610e, plugin 5.13.0 e4eea96)

- Latch key is `JSON.stringify([sessionKey || sessionId, runId])` (collision-free); a live
  latch is never overwritten (`reason=latch-held`); default latch TTL is 6 hours and the latch
  is deleted in `agent_end`'s `finally`.
- Cloud: `PROVIDER_MAP["chatgpt"]` exists; the 422 is raised as `RouteRejected` from the
  resolver and rendered by an app exception handler; only `X-VC-Upstream-Model` is stripped
  (the cloud's own `X-VC-Correlation-ID` and internal-secret headers stay); the twin-route
  flag comes from the rewritten scope path; `_request_path()` prefers the scope path.
- Twin `cost`/`maxTokens` absence is logged, not fatal: the live catalog entries the host
  validates today carry neither.
- Gate agent for §5.0: `webchat-dedicated` (no runs today), twin `gpt-5.6-sol-vc`,
  `agentRuntime.id=openclaw`, fallbacks emptied, `proxyMode.agents={webchat-dedicated: gpt-5.6-sol-vc}`.

- Second code review fold: no `chatgpt` provider subdomain (the ChatGPT upstream is reachable
  only via the exact twin route); every route marker anywhere in the body is stripped after
  admission; `X-VC-Upstream-Model` is validated (plain token, never `-vc`) and never applied off
  the twin route; the latch key is the host run id alone; the latch knows every twin the agent
  may fall back to, so a twin fallback is still proxy-owned; latch TTL default 24 h, floor 1 h;
  a VC command clears the run's latch. Accepted residuals: a native fallback inside a routed run
  receives the marker as an HTML comment and its turn is ingested by the plugin (mismatch path);
  `llm_input` proves the call was made to the twin, not that VC persisted it.

- §5 gate, first live routed run (2026-09-22 04:03Z, plugin 5.13.0, agent `webchat-dedicated`):
  turn 1 bypassed `initial-ingest-pending`, turn 2 `health` (cold cache), turn 3 selected,
  `[hooks] model overridden to gpt-5.6-sol-vc`, marker prepended (117 chars), `llm_input`
  provider=openai/gpt-5.6-sol-vc, `attempt match=true`. The call then failed twice for two
  host-side reasons, both fixed in plugin 5.13.1 / engine `dd25a3b`+`a66df29` / cloud `bb5e404`:
  1. `params.transport=auto` reused the session's cached WebSocket (keyed by session + auth
     identity, not baseUrl) that the real model had opened to chatgpt.com, so the twin request
     never reached VC and the ChatGPT backend answered "The 'gpt-5.6-sol-vc' model is not
     supported when using Codex with a ChatGPT account" (220 ms, no cloud capture). The host then
     put the openai auth profile into a 30 s `model_not_found` cooldown and re-ran the same runId.
     Twins now require `params.transport = "sse"` (validator reason `twin-transport-not-sse`),
     set on `agents.entries.<agent>.models["openai/<twin>"]`.
  2. The SSE path POSTs the body with `Content-Encoding: zstd` (`compressRequestBodyZstd`,
     provider openai). The engine parsed the raw bytes and 500'd (`UnicodeDecodeError` in
     `catch_all`), and the host looped eight "Continue the current task" retries against the 500.
     The engine now decodes gzip/deflate/zstd/br before parsing (415 unknown, 400 corrupt,
     413 past 64 MiB); `zstandard` ships in the `proxy` extra and is in the cloud image.
  Also from that run: the host re-ran the failed attempt under the same runId after `agent_end`
  had released the latch, so the retry carried the twin model but no marker; `before_prompt_build`
  now re-latches from the run's twin model (`relatchProxyRun`). The WebSocket handshake GET the
  auto transport sent to the twin URL is now answered 405 by the cloud without touching upstream.
  Sticky-model check: `session_windows.model` for the probe session stayed `gpt-5.6-sol`; the
  hook override is per run and is not persisted as the session model.

- Second and third live routed runs (2026-09-22 04:26Z to 04:43Z) found three more upstream facts,
  all handled in engine commits 669f68d, f304109, 8e57f6d (subjects: "detect SSE upstream bodies without a
  content type", "rebuild Responses output from item events", "treat host-appended internal context
  as part of the prompt turn") and cloud `9a3e3c2`:
  4. OpenClaw appends a user-role `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` item AFTER the prompt, so the
     prompt is not the last user item: cloud admission now takes the newest marked user item, and the
     engine's Responses format treats the internal-context item as part of the prompt's turn (not the
     current message, not a history pair, forwarded unchanged).
  5. chatgpt.com's `/backend-api/codex/responses` streams SSE with NO content-type header; the
     collector now sniffs the first bytes (`event:`/`data:`) instead of trusting the header.
  6. That stream's terminal `response.completed` carries `output: []`; content arrives only through
     `response.output_item.*` and delta events (usage said output_tokens=6 while our relayed reply was
     empty and the host reported "couldn't generate a response"). The collector now rebuilds
     `output` from the item events when the terminal object has none.
  Each host-side failure was retried by OpenClaw up to five times per turn against the real model
  (about 20 real calls across the probes); the engine's `COLLECT_NOT_JSON` / `COLLECT_NO_TERMINAL`
  warnings now carry status, content type, encoding and body head so the next dialect surprise is
  diagnosed from one call. `/root/vc-harness/infer-twin.sh` signs a marker and makes one twin call via
  `openclaw infer` (note: infer's body carries a system item the ChatGPT backend rejects with 400).

- Fourth live routed run (2026-09-22 04:48Z, engine 669f68d): first fully successful routed turns
  ("OK2", "OK3" via `[hooks] model overridden` → `VC_ROUTE` → `T1 POST openai_responses` → chatgpt.com
  200, no host retries). Two data-quality defects followed, fixed in engine 8d0361b / 4464194 and the
  ingest commit after it, cloud 3b74936:
  7. The engine appended its `<!-- vc:conversation=… -->` reply marker (the routed request carried
     no in-band marker after the cloud stripped the route marker); the host stored it in the
     transcript and showed it to the user. The cloud now sets `request.state.conversation_out_of_band`
     for signed-route requests and the engine reads it at handler time (the resolver runs after
     body parse) to skip the marker.
  8. Routed bodies were ingested with the host's `[Tue 2026-09-22 04:53 UTC] ` prompt stamp
     (duplicating the REST-ingested unstamped turn) and with the internal-context items as user
     turns. Canonical normalization now drops a leading host stamp; the ingest contract skips
     host-context items. Probe conversations from today carry the junk rows and are to be deleted.
  Verified persistence: routed turns land as canonical rows (`probe044837`: OK1 via REST, OK2/OK3 via
  the proxy path) — the plugin's ingest skip is safe.

## 9. Codex-harness route (2026-09-22, plugin 5.14.x, cloud `relay auxiliary backend-api calls`)

Vast and bastkid run on the Codex app-server harness (`selectedHarnessId: codex`), where the model
call is made by the Codex binary (codex-cli 0.153.4, `CODEX_HOME=agents/<id>/agent/codex-home`,
credentials handed over ephemerally by OpenClaw, `credentialSource: profile`). The catalog model's
`baseUrl` is irrelevant there; the binary derives every backend call from `chatgpt_base_url` in its
codex-home `config.toml` (default `https://chatgpt.com/backend-api/`). OpenClaw does not manage that
key: it writes `model_catalog_json`, `tool_output_token` and project trust entries and leaves other
keys alone.

- Route: `chatgpt_base_url = "https://api.virtual-context.com/<vcKey>/backend-api/"` per agent
  (script `/root/vc-harness/codex-route-config.py <agent> [--off]`, backs up openclaw.json and
  config.toml). The binary then sends plugins, apps MCP, `wham/settings`, analytics and the model call
  to the tenant route; the cloud relays everything except the exact `/codex/responses` path untouched
  (`VC_PASSTHROUGH`), admits the model call by the signed marker, and keeps the body's real model
  when no `X-VC-Upstream-Model` header is present.
- Transport: the binary's Responses WebSocket dials `wss://chatgpt.com/backend-api/codex/responses`
  regardless of `chatgpt_base_url` (observed 12:14Z and 12:20Z: every auxiliary call reached VC, the
  model turn did not). Neither `[features] responses_websockets = false` nor `responses_websockets_v2
  = false` stops it, and the built-in provider cannot be overridden ("model_providers contains
  reserved built-in provider IDs: `openai`" → whole config rejected, defaults used). What works
  (12:28Z, gate green, three routed turns 12:29Z): a custom provider selected as the model provider:
  `model_provider = "vc"`, `[model_providers.vc] base_url = "<route>codex", wire_api = "responses",
  requires_openai_auth = true, supports_websockets = false`. ChatGPT auth is attached to it, the
  model call goes to `<route>codex/responses` over HTTPS and the backend answers 200. The plugin
  validator requires that block (`codex-provider:<agent>`) in addition to `chatgpt_base_url`.
- Relay side effects: the binary's `ps/mcp` (apps MCP) call gets 451 `no_biscuit_no_service` from
  chatgpt.com through the relay; Vast never issued that call natively today, so nothing regresses.
  Plugins, settings and analytics relay with 200. On a fresh conversation the engine passes the
  body through (`T0 PASSTHROUGH reason=initial_ingest`, about 26K tokens for the gate turn, most of
  it the harness's own tools and instructions); virtualization applies once history exists.
- Plugin: `proxyMode.codexAgents = {<agent>: true}`. At startup the plugin reads the agent's
  codex-home config and refuses the agent unless `chatgpt_base_url` is exactly this tenant's route
  (`codex-base-url:<agent>`, `codex-config-missing:<agent>`, `codex-and-twin`). No model override is
  made. On each run with an OpenAI model on the codex runtime the plugin latches the run to the real
  model, prepends the signed marker and skips prepare; a run on a non-OpenAI fallback or on the
  embedded runtime stays native; an ephemeral session signs `sk:session:<sessionId>`.
- Ingest: a Codex-routed run gives no per-call proof that VC saw the request (the socket bypass
  above is exactly that case), so the plugin keeps its own ingest and VC's canonical-turn dedupe
  absorbs the copy the proxy stored. Twin routes keep the observed-model rule.
- Gate: `webchat-dedicated` was moved back to the implicit Codex harness (per-model `agentRuntime`
  removed) and its codex-home pointed at the route; probe with `/root/vc-harness/probe-agent.sh
  webchat-dedicated 3`. Native Codex baseline for "Reply with exactly: OK": 46–47K input tokens per
  turn (the harness's own instructions and tools), `agentHarnessId: codex`.
- Vast switched to the Codex route at 12:34Z (probe green, three routed turns, Codex log
  `POST <route>/codex/responses 200` over HTTPS). The engine's `T<n>` accounting on the real guild
  conversation's next organic turn is the halving measurement. Relay narrowed to an allowlist of
  the auxiliary paths (`RELAY_PATH_PREFIXES`) after review: every other `/backend-api/` path is 404
  so no other backend conversation endpoint is reachable unsigned. Validator compares the provider
  booleans as bare TOML literals (a quoted "false" no longer passes).

## 10. Live Vast attempt on the Codex route (2026-09-22 12:34Z–12:43Z) and what it changed

- First organic guild turn hit the route eight times in three minutes (12:40:45Z to 12:43:11Z), 128,159
  input tokens each: the 12:36Z cloud-only `docker compose build` had reused a cached pip layer keyed on
  the compose file's stale `CORE_CACHE_BUST` literal and shipped engine `39410b2` (2026-09-20) without
  the day's collector fixes; every reply was the 140-byte `memory_tool_error` stream inside a 200 and
  the Codex client (UnboundedConnectionRetries) retried. Rolled back 12:43Z; the user's turn was lost.
  Deploys now go only through `scripts/deploy.sh` (verifies `/app/ENGINE_COMMIT`, refuses downgrades,
  runs the smoke, swaps); see memory `feedback_cloud_deploy_only_via_deploy_sh`.
- The captured request also showed why the route could not halve anything as designed: the Codex
  harness carries the whole guild history inside ONE user item (`<conversation_context>`, 326K chars)
  plus a 66K `<recommended_plugins>` user item; VC dropped nothing (`msgs=10 dropped=0`) and added its
  own context (128,159 → 131,497 tokens). Fixes: plugin 5.15.0 windows the context-engine projection
  to `HOST_HISTORY_TAIL` (24) messages for routed agents (VC owns the history); engine `0449027`
  strips the replayed block and the scaffolding user items from canonical text, answers an unreadable
  upstream reply with a terminal 422 decided before any stream starts (one call per failure, not eight),
  and answers a budget overflow with 413.
- Gate harness for long conversations without model calls: `/root/vc-harness/seed-long-session.py
  <agent> <session_key> <pairs>` appends synthetic user/assistant pairs to a probe session's host
  transcript (transcript_events, transcript_event_identities, session_transcript_active_events,
  index state); gateway restart; one routed turn; read `[vc:proxy] projection windowed N -> 24`,
  `[context-diag] pre-prompt … historyTextChars=`, and the engine `T<n> … in= out=` line.

## 11. Proxy mode owns the payload (ruling of 2026-09-22)

- The host sends whatever it builds; VC is the context engineer for the whole outbound payload. The plugin's only proxy-mode duties are routing and handing VC the conversation id (the signed marker in the prompt; the gateway's `before_model_resolve` can only override model and provider, so no per-session query string or header can ride on the model call).
- For a routed agent the plugin does no prompt injection, no end-of-run ingest (`proxyOwnsIngest` is true for the Codex route as of 5.16.0), and no host-registered `vc_*` tools: the route scripts set `agents.entries.<agent>.tools.deny = ["vc_*"]` so the proxy's injected tools are the ones the model sees and runs through VC.
- The tenant parameters (`context_window`, compaction thresholds, `protected_recent_turns`, `tool_output`, assembly budgets) define the outbound payload; no proxy-only budget knob. Per-conversation overrides persist where the engine reads them (cloud 68cf348) and reach every worker within the revision recheck interval (cloud 54c3100).
- Codex payload facts (captured 2026-09-22 13:24Z, Vast guild): the tool catalog rides inside `input` as an `additional_tools` developer item; the current turn's tool loop is `custom_tool_call`/`custom_tool_call_output` items; the whole loop is one turn to VC. The engine counts every item type (6943aba, within 0.2% of provider usage on the captures), stubs consumed tool outputs inside the current turn under protected-zone intrusion keeping the newest two verbatim (82d3aaf), and keeps per-conversation embedding caches packed (417a2fc).
- Order of reduction (Codex review, specs/astra-review-proxy-mode-2026-09-22.md in the engine repo): proven duplicates, reconstructible scaffolding, tool catalog exposure with discovery kept, older history through summaries and retrieval, then selected current-turn tool evidence. Streaming pass-through with VC tool interception is a later coordinator design. Vast stays native until the release gate in that review passes.
- Engine follow-ups the same day: every Codex item type is counted (custom tool calls and outputs, the `additional_tools` catalog scaled 0.75, tool search items, reasoning summaries; matches provider usage within 0.2% on captured Vast calls); per-conversation embedding caches are packed floats (cold worker prepare at Vast scale 7.7 s to 3.2 s); inbound tagging and scoring are memoized per turn in shared state (continuation calls prepare in ~0.3 to 0.5 s on the gate, ~1.1 s at Vast scale); Responses streams are relayed live with the proxy's tool rounds hidden inside one stream. Cloud: a settings change saved on one worker reaches the others on the next request after at most ten seconds (overrides revision check on both registry paths).
- Provider caveat measured on the gate: the Codex backend does not bill pathological tool outputs in full (a 17K-token `seq 1 6000` output billed far less), so like-for-like savings must be read from the provider's usage on realistic payloads; per-call stubbing inside a tool loop moves the cached-prefix boundary every call, which the prompt cache pays for, so window and defer settings decide whether stubbing during a loop is worth it.
- Canonical admission on the Codex route (engine 4a24702): the host-built prompt item (⟦openclaw:ctx⟧ metadata blocks, replayed chat lines, assembled context, workspace files) is split at the last "Current user request:" label; only the requester's words become canonical text and the retrieval query, the tagged JSON blocks become metadata (sender, chat, timestamp, reply subject) and `<environment_context>` is host context. In REST mode the plugin did this stripping itself (index.js `_ASSEMBLED_CONTEXT_LABEL`, `_HISTORY_BLOCK_LABELS`); the proxy route exposed that the engine never had it. Rows admitted before the fix on 2026-09-22 (gate seed conversation, Vast guild 12:30Z to 13:35Z) carry the scaffolding and were left in place.
- Like-for-like on the gate with the relay live (12 realistic shell outputs, 13 calls): 200K window (no reshaping) billed 761K input, 91% cached, 70.8K uncached; 40K window (stubbing each call) billed 655K, 82% cached, 115K uncached. Reshaping a warm tool loop moves the cached prefix and costs more at cached-token prices; the defer setting and the 100% safety valve already say "do not reshape a warm loop".
- Completion-time persistence on the Codex route (engine 23fcf0d, 094f1ea): a finished pair from a provider thread that starts fresh each turn is reserved as the conversation's next logical turn (its payload position collided with an indexed turn and was dropped as a divergent duplicate), and the pair is stored before any compaction signal is acted on (it was skipped whenever the window was already full at completion). Both were found by reading canonical rows after routed gate turns; the release gate for Vast includes that check.
- Prompt-cache rule (owner, 2026-09-22 12:40 PM ET): when tool use is saving through the prompt cache, VC takes the approach that maximizes the cache. Engine: a warm conversation (last upstream request within `flush_ttl_seconds`) holds every payload mutation, not only pending compaction flushes; the over-window valve is the only exception; the last upstream request time is shared across workers (Redis `vc:last_request:<conv>`), since a per-worker clock made a loop spread over eight workers look cold to most of them.

### Note: health is probed at registration

`createProxyHealth` starts in state `unknown`, and `decideProxyOverride` bypasses to native on anything but `ok`. Before 5.16.1 the first probe was kicked by the first `decide()`, so the first routed run after every gateway start went native and the host sent the full transcript to the real model itself (and compacted its own session at its native budget). `warmProxyHealth` now probes every configured key's `/dashboard/settings` once at registration; per-run decisions still answer from cache and never wait on the network.
