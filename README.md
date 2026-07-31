# [Virtual Context](https://virtual-context.com) Plugin for OpenClaw

> **[virtual-context.com](https://virtual-context.com)** — OS-style memory for LLMs. Less context. Better answers.

[Virtual Context](https://virtual-context.com) lets your agents run with unlimited context windows while sending only what matters to the LLM. Conversations are compressed, organized, and indexed automatically. When context is needed, it's retrieved semantically and injected into the payload. The result: unlimited memory, lower token costs, and better reasoning from models that see clean, relevant context instead of raw history.

This plugin provides deep OpenClaw integration via the Virtual Context REST API. For other frameworks, the [transparent proxy](https://virtual-context.com/docs/) requires zero code changes.

## What It Does

- **Prepare** — before each LLM call, sends your messages to the Virtual Context cloud. Gets back a compressed payload with relevant historical context injected.
- **Tools** — registers seven retrieval tools (`vc_expand_topic`, `vc_find_quote`, `vc_recall_all`, `vc_query_facts`, `vc_remember_when`, `vc_restore_tool`, `vc_find_session`) that the LLM can call to pull in more context on demand.
- **Ingest** — after each LLM response, sends the assistant's reply to the cloud for tagging and indexing.
- **Speaker-attributed group history** *(optional)* — the plugin can also serve as OpenClaw's context engine, adding trusted `senderName` / `senderId` attribution to the group-chat history OpenClaw renders as `<conversation_context>`, so the model can tell speakers apart in a multi-person channel. Off unless selected; see [Context engine](#context-engine-optional).

## Installation

```
openclaw plugins install clawhub:virtual-context
```

After installing, confirm which version actually loaded — see [Verifying it works](#verifying-it-works). The gateway log reports the running version on every startup.

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "virtual-context"
    },
    "entries": {
      "virtual-context": {
        "enabled": true,
        "config": {
          "vcKey": "vc-your-key-here",
          "baseUrl": "https://api.virtual-context.com",
          "providers": ["openai-direct/gpt-5.4"],
          "convIdentity": "stable",
          "debug": false,
          "modelCallCapture": {
            "enabled": false,
            "maxBytes": 536870912,
            "maxFiles": 2000,
            "maxAgeHours": 168
          }
        }
      }
    }
  }
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `vcKey` | string | required | Your Virtual Context API key. Sent as the `vckey` query parameter on every request. |
| `baseUrl` | string | `https://api.virtual-context.com` | VC REST API base URL |
| `providers` | string[] | all | Provider/model pairs to activate for. Empty = all providers. Example: `["openai-direct/gpt-5.4"]` |
| `convIdentity` | `"session"` \| `"stable"` | `"session"` | How VC conversations are keyed. **See below — the default is legacy behavior.** |
| `conversationGroups` | object | none | Map of group session key to member session keys, so several chat scopes share one VC conversation. Requires `convIdentity: "stable"`. |
| `debug` | boolean | `false` | Enable verbose logging of REST API calls and payloads |
| `modelCallCapture` | object | disabled | Store complete, untruncated `llm_input` and `llm_output` hook payloads in a bounded local gzip log. Defaults to 512 MiB, 2,000 files, and 7 days under `~/.openclaw/logs/virtual-context/model-calls`. |

### Conversation identity — read this before going to production

`convIdentity` decides what a "conversation" means to Virtual Context, and the default is the legacy behavior:

- **`"session"` (default)** — VC conversations are keyed by OpenClaw's session UUID. That UUID **rotates**: when a session resets on idle or on a scheduled reset, the next turn starts a brand-new VC conversation and the prior memory is no longer the active context.
- **`"stable"`** — durable chat scopes are keyed by their session key instead, so **memory survives session rotation**. Discord DMs, group DMs, guild channels, and direct sessions each keep their own durable identity.

If you want a bot that still remembers last week, set `convIdentity: "stable"`.

`conversationGroups` maps one group session key to a list of member session keys; every member then shares the group key's stable VC conversation. Exact stable keys are supported. A terminal `agent:<agent>:discord:channel:*` wildcard is accepted only when OpenClaw binds that agent to an allowlisted Discord account with exactly one explicit guild, and the group key names that guild. Discord DMs and group DMs always remain separate conversations. The plugin logs a warning and ignores the setting if `convIdentity` is not `"stable"`.

### Context engine (optional)

Selecting the plugin as OpenClaw's context engine turns on speaker-attributed group history:

```json
"plugins": { "slots": { "contextEngine": "virtual-context" } }
```

This is an OpenClaw-level slot, not a key inside the plugin's own `config` block. When selected, the plugin preserves OpenClaw's legacy context-engine lifecycle and stock compaction, and adds trusted `senderName` / `senderId` attribution to the in-memory group-chat history. Discord DMs and direct sessions are unchanged, missing metadata is never guessed, and stored conversation text is not rewritten. Omit the slot to leave OpenClaw's default context engine in place.

## How It Works

The plugin observes seven OpenClaw lifecycle hooks:

1. **`message_received`** — records the channel-owned routing ids for the turn (message id, sender, reply target). No network call, no writes.
2. **`before_agent_reply`** — claims VC slash commands and reply-only invocations before the prompt is built.
3. **`before_prompt_build`** — calls `/api/v1/context/prepare` with the message history. The cloud returns a compressed payload with context injected and old turns trimmed; the plugin replaces the messages in place and applies a system-prompt override if the cloud sent one.
4. **`llm_input`** / 5. **`llm_output`** — observability, plus the opt-in model-call capture.
6. **`agent_end`** — calls `/api/v1/context/ingest` with the assistant's reply text for tagging and compaction.
7. **`message_sending`** — strips internal `<!-- vc:... -->` markers from outbound text.

**Tool definitions.** The seven retrieval tools ship with definitions built into the plugin, so it works with no bootstrap network call. On top of that, the plugin refreshes a tool's schema from `/api/v1/tools/definitions` lazily — per conversation, on first use, cached for 60 seconds and de-duplicated while a refresh is in flight. The refresh exists because the server binds a request-local speaker enum into eligible schemas from that conversation's current roster. If the fetch is stale, failing, or disabled, the built-in definitions are used unchanged, so tool registration never depends on the network.

**Tool calls.** When the LLM invokes a VC tool, the plugin calls `/api/v1/tools/{name}` and returns the result.

## Commands

The plugin registers five native slash commands, which work in any channel OpenClaw serves:

| Command | What it does |
|---------|--------------|
| `/vcstatus` | Show VC conversation status — ingest state, watermarks, tokens. **The quickest way to confirm the plugin is working.** |
| `/vcmerge` | Merge VC tags. `/vcmerge PREVIEW` shows the result without applying it. |
| `/vclabel` | Set or update the conversation label, e.g. `/vclabel My Project`. |
| `/vcattach` | Attach a tag/topic to the VC conversation. Creates a durable alias redirect; it does **not** delete the previous conversation. |
| `/vcreingest` | Reset the local ingest tracker so the next message re-sends full history. Local only — no cloud call. |

On gateways that don't expose command registration the plugin skips these and logs that it did; every command is also reachable by typing the equivalent `VC...` prompt text.

## Verifying it works

**1. Check the plugin loaded, and which version.** On gateway startup:

```
[vc] register() v5.4.8 — baseUrl=... convIdentity=... groupedSessions=... providers=...
[vc] registered 7 tools (dynamic schemas, hardcoded fallback)
[vc] registered 5 native slash commands (vcstatus, vcmerge, vclabel, vcattach, vcreingest)
```

The `register()` line reports the version actually running and the conversation-identity mode in effect — check it after installing or upgrading.

**2. Run `/vcstatus`** in any conversation. This is the fastest end-to-end confirmation.

**3. Watch a real turn.** Each served turn logs a prepare and an ingest:

```
[vc] prepare OK — conversation=...
[vc] ingest OK — conversation=... status=... compaction=...
```

Filter the gateway log for `[vc]` to see them. Useful lines when something looks wrong:

- `[vc] skipping prepare —` / `[vc] skipping ingest —` — the provider filter excluded this turn. Check `providers`.
- `[vc] ingest SKIPPED — no reply text in turn` — the turn produced no assistant text to store.
- `[vc] WARNING: ...` — configuration the plugin believes will cause trouble (see below).
- `[vc] tool definitions refresh failed for ...` — the schema refresh failed; built-in definitions are still in use, so tools keep working.

Set `debug: true` for verbose `[vc:debug]` and `[vc:wire]` request/response logging. Disable it in production.

**Startup warnings.** The plugin warns when `agents.defaults.contextPruning.mode` is not `"off"`, when `agents.defaults.contextTokens` is low, or when `session.resetByType.group.idleMinutes` is short enough that OpenClaw would reset a session and discard history before VC records it.

## Provider Filtering

By default, the plugin activates for all providers. Use the `providers` config to restrict it to specific provider/model combinations. The plugin reads the current model from the session store at runtime, so it correctly handles `/model` switches.

## Security and Access

This plugin is transparent about what it accesses. Here is the full list:

**Network calls (to your configured `baseUrl`):**
- Sends conversation messages to `/api/v1/context/prepare` before each LLM call
- Sends assistant reply text to `/api/v1/context/ingest` after each LLM response
- Refreshes tool schemas from `/api/v1/tools/definitions` lazily per conversation (see [How It Works](#how-it-works))
- Calls `/api/v1/tools/{name}` when the LLM requests a retrieval tool

**Local filesystem reads:**
- `~/.openclaw/agents/<agentId>/sessions/sessions.json` — the current model, for provider filtering. Read-only; needed because the `before_prompt_build` hook does not expose the active model.
- The active session JSONL — to recover speaker names that OpenClaw omits from model-facing history objects, and to send full history on a conversation's first prepare.
- `~/.openclaw/openclaw.json` — the plugin's own configuration and the gateway settings it warns about. Cached by modification time and size.
- Its own ingest tracker (below).

**Local filesystem writes:**
- `~/.openclaw/extensions/virtual-context/initialized-sessions.json` — a small tracker recording which sessions have had their history ingested, so a full-history upload happens once per session rather than on every turn. **This file is always written; it is not optional.** It holds session ids and counts, not conversation content. `/vcreingest` clears a session's entry.
- Nothing else, unless `modelCallCapture.enabled` is `true`.

**Model-call capture (opt-in, off by default):**
- Writes one atomic mode-`0600` gzip JSON file for every `llm_input` and `llm_output` event, into `~/.openclaw/logs/virtual-context/model-calls` (directory mode `0700`), alongside a short `README` describing the format.
- Captures every field exposed by OpenClaw's `llm_input`/`llm_output` hooks—including complete system prompt, user prompt, local history messages, output, usage, and run/session/provider correlation—without the built-in trajectory's string truncation.
- Enforces total compressed bytes, file count, and age on every write, deleting the oldest captures past those limits.
- Contains conversation content. Restrict access accordingly.
- OpenClaw does not expose provider request bytes, tool definitions/images, or state retained inside a persistent provider thread through these hooks. The capture records that limitation and can be correlated by `runId`/`sessionId` with OpenClaw's trajectory `threadId`; it does not falsely claim to materialize provider-side state.

**Payload modification:**
- Replaces the message array in-place with the compressed payload returned by the cloud
- Can override the system prompt if the cloud returns one (VC manages the full payload to compress it)
- When selected as the context engine, adds speaker attribution to in-memory group history

**Debug logging (opt-in, off by default):**
- When `debug: true`, logs message previews, API responses, and payload sizes to the gateway log. Disable in production.

**What it does NOT do:**
- Does not write conversation content to disk unless `modelCallCapture.enabled` is explicitly set to `true`
- Does not read files outside your OpenClaw directory; opt-in captures are written only to the configured capture directory
- Sends context data only to your configured `baseUrl`; when Discord omits a
  native reply quotation, it may read that exact same-channel message from the
  Discord API using the already-configured bot account
- Does not store credentials or API keys beyond what is in your `openclaw.json` config

## Getting a vcKey

Sign up at [virtual-context.com](https://virtual-context.com) to get your API key. See the site for current plans and pricing.

## Learn More

- [virtual-context.com](https://virtual-context.com) — product overview, pricing, and signup
- [Documentation](https://virtual-context.com/docs/) — integration guides for Anthropic, OpenAI, and more
- [Research Paper](https://virtual-context.com/paper/) — the technical paper behind Virtual Context
- [GitHub](https://github.com/virtual-context/openclaw-plugin) — plugin source code

## Changelog

### 5.4.8

- **Reply attribution without a run id**: group replies are attributed correctly when the host provides no run-scoped identity for the turn, instead of falling back to an unattributed speaker.

### 5.4.7

- **Run-bound current speaker and native reply target**: group turns now join
  OpenClaw's channel-owned `runId`, message id, sender snowflake, and reply id
  before attribution. Host-generated reaction notices can no longer break the
  current-speaker handoff. When Discord omits the quoted reply body, the plugin
  verifies the current message's same-channel native reference and restores a
  bounded, explicitly untrusted target quotation; conflicting, forwarded,
  cross-channel, or post-reply-edited targets fail closed. Reply content travels
  in a separate provenance lane and is never concatenated into requester text.

### 5.4.6

- **Invoked-turn current-speaker proof**: group turns now capture OpenClaw's channel-owned `senderId` at `before_agent_reply`, bind it to the exact session, session key, and normalized request hash, and require it to agree with the structured current-turn actor provenance before VC receives an actor id or the model receives a `<current-speaker>` boundary. History-only context-engine passes retain that same-turn proof rather than clearing it. This applies only when the agent is invoked; unrelated channel messages, direct messages, stored history, and actor-card write policy are unchanged.
- **Reply text recovery**: a turn that ends on a delivery tool call still yields its reply text for ingest, and the reply scan is bounded to the turn's own entries rather than scanning back through conversation history.
- **Heartbeat turns are excluded** from the context service.

### 5.4.5

- **Current-speaker identity at the authoritative lifecycle seam**: the selected context engine now hands the exact trailing current turn's trusted `senderName`/`senderId` to the later prompt hook through a short-lived, body-hash-bound in-memory record. This supplies structured actor provenance to VC and binds any returned actor card without waiting for the current row to be written to session JSONL. Only invoked model turns pass through this seam; unrelated Discord messages, DMs, stored transcripts, and actor-card write policy are unchanged.

### 5.4.4

- **Exact current-speaker binding without a prompt envelope**: invoked group turns can bind the current speaker's actor card from the newest OpenClaw-owned session row when `before_prompt_build` omits channel identity. The row must be the newest user row, its body must exactly match the current request, and its sender id, name, and platform must be valid; any independently available prompt or hook identity must agree. Direct messages, older-row searches, canonical history, and actor-card writes are unchanged.

### 5.4.3

- **Speaker-attributed native group history**: when selected with `plugins.slots.contextEngine: "virtual-context"`, the plugin preserves OpenClaw's legacy context-engine lifecycle and stock compaction while adding trusted `senderName`/`senderId` attribution to the in-memory group-chat history that OpenClaw renders as `<conversation_context>`. Discord DMs and direct sessions are unchanged, missing metadata is never guessed, and stored OpenClaw/VC conversation text is not rewritten.

### 5.3.0

- **Certified Discord channels route into one server conversation**: channels certified for a guild share a single stable VC conversation, so server-wide memory is continuous instead of fragmenting per channel. Discord DMs and group DMs remain separate.

### 5.2.0

- **Stable conversation identity** (`convIdentity: "stable"`): VC conversations can be keyed by durable session keys instead of OpenClaw's rotating session UUID, so memory survives session rotation. Stable identity covers Discord guild, direct, and group scopes. Cron-triggered sessions are treated as ephemeral and excluded. The legacy UUID behavior remains the default.
- **`conversationGroups`**: several chat scopes can share one stable VC conversation via a group-key-to-members map, with a guarded terminal wildcard for a single allowlisted guild.
- **Speaker names in group chats**: every message in a group conversation carries its speaker, so the model can tell participants apart.
- **Turn storage records what the user actually said**: the stored user half is the turn's own text, with the host's replayed numbered chat-history block removed and host provenance kept separate from conversation content. Reply-only invocations record their user half instead of being dropped.
- **`vc_find_quote` accepts an optional channel scope** for conversations spanning multiple channels.

### 5.1.2

- **Native slash commands**: `/vcstatus`, `/vcmerge`, `/vclabel`, `/vcattach`, and `/vcreingest` register directly with the host, so each channel routes them through the native command pipeline instead of a prompt-text round trip.
- **System preamble hoisting**: a `role: "system"` preamble in the prepare response is hoisted into `body.system` rather than being left in the message array.
- **Provider-filter visibility**: the plugin warns once when the filter starts skipping a session it had previously been passing.

### 5.1.1

- **Wire-log observability**: the `[vc:wire] POST <path>` log line now appends `timeout=Nms` so the prepare-call timeout selection is grep-able from gateway logs. VCMERGE / VCMERGE PREVIEW requests show `timeout=60000ms`, normal prepares show `timeout=15000ms`, and initial JSONL ingest shows `timeout=120000ms`.
- **Wire-shape tests strengthened** to pin the full prepare-payload body shape (role, content[].type, model presence/absence) for both `VCMERGE INTO` and `VCMERGE PREVIEW`, not just message count + prompt text.
- **Lockfile regenerated** to record 5.1.1 (runtime payload was unaffected because `package.json` `"files"` excludes the lockfile).

### 5.1.0

- **VCMERGE support**: the plugin's existing `^VC[A-Z]/i + vc_command + prependContext` rail handles `VCMERGE INTO <target>`, `VCMERGE PREVIEW <target>`, and the reserved-for-v2 `VCMERGESTATUS <merge_id>` natively. No new dispatch code; cloud's REST endpoint resolves these alongside VCATTACH/VCSTATUS/VCLABEL/etc.
- **Timeout sizing for VC commands**: prepare-call timeout is now `60s` for any VC command (matches against `^VC[A-Z]/i`). Previous behavior was `15s` everywhere except `120s` on initial JSONL ingest. This gives sync-path merges comfortable headroom — VCMERGE on conversations >5k turns may take several seconds (sync path); >10k turns return a `merge_id` immediately for async tracking via `VCMERGESTATUS`.
  - **Alarm-threshold rule**: the 60s cap is a forcing function, NOT a tuning knob. If real-world p99 nears 60s, the right lever is dropping cloud's `max_sync_source_turns` to push into the async path — NOT bumping this timeout further. Bumping past 60s would mask the sync-path getting too slow rather than escalating it.
- **Test infrastructure**: the plugin now ships a `vitest` + `fetch-mock` test harness in `tests/`. Tests cover the timeout-per-branch contract, URL+body construction, and the message/error/bracket fallback chain over canonical error envelopes. Run via `npm test`. Dev-only: `tests/` and `node_modules/` do not bundle into the runtime npm package (per `package.json` `"files"`); end-user installs are unchanged.

### 5.0.1

- Defensive fix: VC command error responses now render correctly when the cloud populates the `error` field without a `message` field. Previously, error responses (such as `VCATTACH` against a missing target) rendered the placeholder string `[VC <command>]` and the user saw no error context. The plugin now falls back to `prepareResult.error` before the placeholder.

### 5.0.0

- Hardcoded retrieval tool definitions (no bootstrap network call).
- VC command handling via `prependContext` (keeps history clean).
- JSONL ingest tracking with `VCREINGEST` reset command.
- Wire-level request logging in debug mode.
