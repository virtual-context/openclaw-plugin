# [Virtual Context](https://virtual-context.com) Plugin for OpenClaw

> **[virtual-context.com](https://virtual-context.com)** — OS-style memory for LLMs.

[Virtual Context](https://virtual-context.com) (VC) gives an agent long-term memory. Every completed turn is stored, tagged, and compacted into summaries and facts in the VC service. On each new turn VC assembles the relevant stored context into the payload and trims history the model no longer needs, and the model can call retrieval tools to pull in more.

This plugin connects OpenClaw agents to VC in one of two ways:

- **REST mode (default).** Before each agent turn the plugin sends the conversation to the VC service and replaces the history with the payload VC returns; after the turn it sends the reply back to be stored.
- **Proxy mode (opt-in, per agent).** The agent's model calls go through the VC proxy, so VC shapes every model call of the turn, including each round of a tool loop, and records the turn itself. See [Proxy mode](#proxy-mode).

## Contents

- [What it does](#what-it-does)
- [Installation](#installation)
- [Configuration](#configuration)
- [Conversation identity](#conversation-identity)
- [Context engine (optional)](#context-engine-optional)
- [Proxy mode](#proxy-mode)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Verifying it works](#verifying-it-works)
- [Provider filtering and excluded agents](#provider-filtering-and-excluded-agents)
- [Security and access](#security-and-access)
- [Changelog](#changelog)

## What it does

- **Prepare** — once per agent turn, before the prompt is built, sends the conversation to VC and replaces the message history with the payload VC returns: stored context added, old turns trimmed, or the history unchanged when VC decides no change is needed. A session's first prepare also uploads its full existing history.
- **Retrieval tools** — registers seven tools the model can call to pull in stored context on demand: `vc_expand_topic`, `vc_find_quote`, `vc_recall_all`, `vc_query_facts`, `vc_remember_when`, `vc_restore_tool`, `vc_find_session`.
- **Ingest** — once per completed agent turn, sends the user message and the assistant's reply to VC to be stored, tagged, and compacted.
- **Commands** — five slash commands (`/vcstatus`, `/vcmerge`, `/vclabel`, `/vcattach`, `/vcreingest`) for inspecting and managing the VC conversation. See [Commands](#commands).
- **Speaker attribution in group chats** *(optional)* — as OpenClaw's context engine, labels each message in group-chat history with its sender so the model can tell participants apart. See [Context engine](#context-engine-optional).

## Installation

```
openclaw plugins install clawhub:virtual-context
```

Then add your key to the plugin config (below) and restart the gateway. The gateway log prints the running version at startup; see [Verifying it works](#verifying-it-works).

## Configuration

Plugin settings live under `plugins.entries.virtual-context.config` in `openclaw.json`. A minimal setup:

```json
{
  "plugins": {
    "entries": {
      "virtual-context": {
        "enabled": true,
        "config": {
          "vcKey": "vc-your-key-here",
          "convIdentity": "stable"
        }
      }
    }
  }
}
```

Without a `vcKey` the plugin logs a warning and does nothing.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `vcKey` | string | none | Your VC key. Sent as the `vckey` query parameter on REST calls and as a path segment on proxy routes. |
| `baseUrl` | string | `https://api.virtual-context.com` | VC service URL. Its host is also the host proxy routes must point at. |
| `providers` | string[] | all | Only turns whose current model matches one of these `provider/model` values (case-insensitive) use VC. Empty means all. See [Provider filtering](#provider-filtering-and-excluded-agents). |
| `excludeAgents` | string[] | none | Agent ids whose turns never get prepare, ingest, typed VC commands, or proxy routing. See the [limits](#provider-filtering-and-excluded-agents). |
| `convIdentity` | `"session"` \| `"stable"` | `"session"` | How turns map to VC conversations. See [Conversation identity](#conversation-identity). |
| `conversationGroups` | object | none | Map of a group session key to member session keys; members share the group's VC conversation. Requires `convIdentity: "stable"`. |
| `discordMemoryScope` | object | none | Per-agent `"server"` policy: one VC conversation per Discord server instead of per channel. Requires `convIdentity: "stable"`. |
| `agentKeyFiles` | object | none | Map of agent id to a file containing that agent's VC key (`vc-` followed by 40 hex characters). That agent then uses that key and its tenant; other agents use `vcKey`. Unreadable or malformed entries fall back to `vcKey` with a log line. |
| `agentActorIds` | object | none | The agent's own platform user ids by platform, e.g. `{"discord": "1485..."}`, so its own quoted output is not attributed to a member. Checked at startup against other plugins' Discord bot ids; a mismatch disables it. |
| `outboundIdCapture` | object | `{"mode": "off"}` | Records the bot's own outbound message ids so a member's reply to the bot can be matched. Requires `convIdentity: "stable"`. |
| `ingestRetry` | object | `{"enabled": false}` | Retries an ingest the service rejects as busy (`conversation_lifecycle_busy`). Timeouts are never retried. |
| `operatorNoticeUserId` | string | none | Discord user id that receives model-fallback notices as a direct message; the in-channel notice is cancelled. Without a usable bot token the notice stays in the channel. |
| `modelCallCapture` | object | disabled | Writes every `llm_input` and `llm_output` event, untruncated, to a local gzip log. Limits default to 512 MiB, 2,000 files, and 7 days, under `~/.openclaw/logs/virtual-context/model-calls`. Contains conversation content. |
| `proxyMode` | object | disabled | Routes selected agents' model calls through the VC proxy. See [Proxy mode](#proxy-mode). |
| `debug` | boolean | `false` | Verbose `[vc:debug]` and `[vc:wire]` logging of requests and payloads. |

## Conversation identity

`convIdentity` decides which turns belong to the same VC conversation.

- **`"session"` (default)** — keyed by OpenClaw's session id. That id changes when OpenClaw resets a session, and the next turn then starts a new VC conversation.
- **`"stable"`** — keyed by the session key, so memory survives session resets. This covers the `main` session, Discord DMs, group DMs, and guild channels, Telegram direct and group chats, and per-user web chat. Cron, sub-agent, and other one-off sessions keep a per-session conversation.

For an agent that should remember past conversations, set `convIdentity: "stable"`.

**`conversationGroups`** maps a group session key to a list of member session keys; each member uses the group key's conversation. Exact keys are supported, and so is one wildcard form, `agent:<agent>:discord:channel:*`, accepted only when OpenClaw binds that agent to an allowlisted Discord account with exactly one explicit guild and the group key names that guild. Discord DMs and group DMs are never matched by the wildcard. The setting is ignored, with a warning, unless `convIdentity` is `"stable"`.

**`discordMemoryScope`** — set `"discordMemoryScope": { "<agent-id>": "server" }` together with `"convIdentity": "stable"` to give that agent one conversation per Discord server across all its channels. Server membership comes from the inbound message metadata or, when unknown, from a Discord API channel lookup with the agent's bound bot account; failed lookups are retried after 30 seconds. The agent needs explicit Discord account bindings. Direct messages keep their own conversations, and the original channel is kept as provenance. If a channel's server cannot be determined, VC is bypassed for that turn and a warning is logged, rather than creating a separate conversation.

## Context engine (optional)

Selecting the plugin as OpenClaw's context engine is an OpenClaw-level setting, not part of the plugin config:

```json
"plugins": { "slots": { "contextEngine": "virtual-context" } }
```

When selected, the plugin keeps OpenClaw's normal context lifecycle and compaction, and changes only the in-memory history the model sees:

- **Speaker labels.** In group chats on any platform (Discord channels and guilds, group DMs, Telegram groups), each user message is prefixed with a `<message-speaker>` block carrying the sender's name and platform id, taken from OpenClaw's own message metadata. Messages without that metadata are marked as unattributed instead of guessed. Member-typed lookalikes of these tags are escaped. Stored transcripts are not rewritten, and direct messages are unchanged.
- **Image labels.** On hosts that flatten history into text (the Codex app server), images in history are replaced by labeled copies so the model can tell which image belongs to which message. The copies are made by a bundled Python script (`tools/label_image.py`) and stored under `<workspace>/media/inbound/vc-labeled/`, capped at 256 MB.
- **Compaction signal.** After OpenClaw compacts a session, the next prepare sends only the current turn instead of the compacted survivors and summary, since VC already holds every stored turn. This logs `[vc] suppressing N post-compaction survivor message(s)`.

Omit the slot to keep OpenClaw's default context engine.

## Proxy mode

In proxy mode an agent's model calls go to the VC proxy instead of directly to the model provider. VC then prepares every model call of a turn (including each round of a tool loop) and records the turn itself, so the plugin skips its own prepare for routed turns and does not ingest them again.

```json
"proxyMode": {
  "enabled": true,
  "agents": { "my-agent": "gpt-5.6-sol-vc" },
  "codexAgents": { "my-codex-agent": "gpt-5.6-terra" }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Master switch. |
| `agents` | none | Agents on OpenClaw's embedded runtime, each mapped to a VC-routed "twin" model. |
| `codexAgents` | none | Agents on the Codex harness whose Codex config points at the VC route. Value `true`, or an OpenAI model id to switch to while VC is down. |
| `healthTimeoutMs` | `1500` | Timeout of the VC health check (minimum 100). |
| `healthTtlMs` | `60000` | How long a health result is reused (minimum 1000). |
| `latchTtlMs` | 24 hours | How long an unreleased routing decision is kept (minimum 1 hour). |

Each agent's route is validated when the plugin starts. A valid agent logs `[vc:proxy] ENABLED agent=<id> twin=<model>` or `[vc:proxy] ENABLED agent=<id> route=codex`; an invalid one logs `[vc:proxy] DISABLED agent=<id> reason=<reason>` and keeps using REST mode.

Routed requests carry the model provider credentials the agent already uses; VC forwards them to the provider.

### Twin-model agents (`agents`)

Each run is switched to a twin catalog entry that points at the VC route. For `<model>`, the agent's primary model must be `openai/<model>` running on the `openclaw` runtime, and `models.providers.openai.models` must contain an entry `<model>-vc` with:

- `api`: `"openai-chatgpt-responses"`
- `baseUrl`: `https://<baseUrl host>/vc-<key>/backend-api`
- header `X-VC-Upstream-Model: <model>`
- `params.transport`: `"sse"`

A run stays on REST mode instead of switching when: it is a heartbeat, the agent is excluded, the prompt is a typed VC command, the session's initial history upload has not happened yet, the session has no stable identity, or the last health check was not OK. These log `[vc:proxy] bypass agent=<id> reason=<reason>`. The plugin skips ingest for a twin run only when every model call of the run went to the twin.

### Codex agents (`codexAgents`)

The agent's `~/.openclaw/agents/<id>/agent/codex-home/config.toml` must contain:

```toml
chatgpt_base_url = "https://<baseUrl host>/vc-<key>/backend-api"
model_provider = "vc"

[model_providers.vc]
name = "OpenAI via Virtual Context"
base_url = "https://<baseUrl host>/vc-<key>/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

`<key>` is the VC key that agent uses (from `agentKeyFiles` or `vcKey`), and the booleans must be unquoted. The plugin always leaves ingest of Codex-routed runs to the proxy.

**Fallback while VC is down.** If the value is a model id, the plugin checks VC's health immediately before each run and, when the check fails, switches the run to that model, which then runs in REST mode. The fallback model must run on the embedded runtime (`agentRuntime.id: "openclaw"` for `openai/<model>` in the agent's `models`), because a Codex-harness model would use the same unavailable route. A fallback that is not on the embedded runtime is dropped with a `DISABLED ... reason=codex-fallback-not-embedded:<model>` log line, while the agent itself stays routed.

**Health check.** `GET <baseUrl>/vc-<key>/dashboard/settings`; any 2xx response counts as healthy. It runs at startup, and results are refreshed in the background after `healthTtlMs`.

## Commands

Five slash commands are registered with OpenClaw (on gateways without command registration they are skipped, with a log line). Each can also be typed as plain text, e.g. `VCSTATUS` or `VCATTACH My Project`; typed commands must be the whole message and are case-insensitive. Except for `/vcreingest`, each command is sent to the VC service and its reply is shown in the chat.

| Command | What it does |
|---------|--------------|
| `/vcstatus` | Shows this conversation's VC state: label, status, ingestion progress, compaction watermarks, stored segments and tag summaries, last payload size and tokens, cache-hit rate, working set, and active tags. The quickest check that the plugin is working. |
| `/vclabel [name]` | With a name, sets this conversation's label. Without one, shows the current label. |
| `/vcattach <label or id>` | Attaches the current session to an existing VC conversation, chosen by label (case-insensitive), exact id, or unique id prefix. From then on this session reads and writes that conversation. Nothing is deleted: the previous conversation keeps its data, and you can attach back to it later. Replies `Conversation attached to <label> (<id>). History restored.` |
| `/vcmerge INTO <label or id>` | Merges this conversation into the target: its stored turns move to the target, the target's data wins on conflicts, and this conversation becomes an alias of the target. The target must be a single word (label or exact id). Refused when the target is this conversation, cannot be found, or is too large to merge. `/vcmerge PREVIEW` is recognized but not implemented yet. |
| `/vcreingest` | Local only, no service call: clears this session's entry in the plugin's upload tracker, so the next prepare re-uploads the session's full history from disk. |

Typed text also accepts `VCRECALL`, `VCCOMPACT`, `VCLIST`, `VCFORGET`, and `VCMERGESTATUS`, which the VC service handles and which have no slash command.

## How it works

The plugin registers ten OpenClaw hooks:

| Hook | What the plugin does |
|------|----------------------|
| `message_received` | Records the turn's routing ids (message, sender, reply target, Discord server membership) in memory. No network call. |
| `before_model_resolve` | Proxy mode: switches the run to its twin model, or to the Codex agent's fallback while VC is down. |
| `before_dispatch` | Binds the inbound Discord message to the session about to run. |
| `before_agent_reply` | Answers typed VC commands without running the model. |
| `before_prompt_build` | Runs prepare and replaces the message history with VC's payload; applies the provider filter and exclusions. Skipped for proxy-routed runs, which only get a signed route marker. |
| `llm_input` / `llm_output` | Model-call capture when enabled, and proxy-mode bookkeeping. |
| `agent_end` | Runs ingest for the completed turn. Skipped for command turns, failed runs, filtered models, and proxy-owned runs. |
| `message_sending` | Strips internal `<!-- vc:... -->` markers from outbound text and reroutes fallback notices when `operatorNoticeUserId` is set. |
| `message_sent` | Records the bot's outbound message ids. Registered only when `outboundIdCapture` is enabled. |

**How VC's context reaches the model.** Prepare replaces `event.messages` with VC's payload. VC's system text is applied as a system-prompt override, or, on the Codex runtime and in group chats, prepended to the prompt instead.

**Discord guild channels in stable mode** use source-attested endpoints for prepare and ingest, and deliver each completed turn through a local outbox so it survives restarts (see [Security and access](#security-and-access)).

**Tools.** The seven tools have definitions built into the plugin, so registering them needs no network call. When the host builds a tool, the plugin fetches the current definitions from `/api/v1/tools/definitions` in the background (per conversation and channel, cached for 60 seconds) and uses them on later calls; until then, or if the fetch fails, the built-in definitions are used. A tool call is sent to `/api/v1/tools/<name>`, and errors are returned to the model as text.

**Timeouts.** Prepare: 30 s, 60 s for VC commands, 120 s for a session's initial history upload. Ingest and tool calls: 15 s. Tool definition fetch: 8 s. If prepare fails, the turn proceeds with its unmodified history.

## Verifying it works

**1. The plugin loaded.** On gateway startup:

```
[vc] register() v5.17.1 — baseUrl=... debug=... convIdentity=... groupedSessions=... agentKeys=<loaded>/<configured> providers=...
[vc] registered 7 tools (dynamic schemas, hardcoded fallback)
[vc] registered 5 native slash commands (vcstatus, vcmerge, vclabel, vcattach, vcreingest)
```

The `register()` line shows the version actually running and the identity mode in effect.

**2. Run `/vcstatus`** in a conversation. It is a real round trip to the VC service.

**3. Watch a turn.** A REST-mode turn logs:

```
[vc] prepare OK — conversation=... passthrough=... tags=... tokens_added=...
[vc] ingest OK — conversation=... status=... compaction=...
```

Group turns log `[vc] run-bound group ingest OK` instead of the ingest line. Proxy-routed turns log `[vc:proxy] routed run — prepare skipped` and `[vc:proxy] ingest skipped`.

**Useful log lines when something looks wrong:**

- `[vc] skipping — <model> not in provider filter` / `[vc] skipping ingest — <model> not in provider filter; session=...` — the provider filter excluded the turn.
- `[vc] WARN provider filter now SKIPPING` — a session that was using VC fell off the allowlist, usually after a model fallback. Logged once per change.
- `[vc] session=... has NEVER passed the provider filter` — logged on the first skip and every 25th after, naming the model to add.
- `[vc] provider filter NOT EVALUATED` / `[vc] WARN provider filter CANNOT EVALUATE` — the session's model could not be determined. After 3 consecutive such turns the plugin stops using VC for the session and logs `[vc] skipping — model unresolved`.
- `[vc] skipping prepare —` / `[vc] skipping ingest —` — a heartbeat turn, or an agent in `excludeAgents`.
- `[vc:agent-keys] KEYS MISSING` — an `agentKeyFiles` entry failed to load; that agent uses `vcKey`.
- `[vc] ingest SKIPPED — no reply text in turn` — the turn produced no reply text to store.
- `[vc] tool definitions refresh failed for <conversation>: <error>` — the built-in or previously fetched definitions stay in use.
- `[vc] WARNING: ...` — startup configuration warnings: `agents.defaults.contextPruning.mode` is not `"off"`, `agents.defaults.contextTokens` is above 2,000,000 (oversized budgets stop OpenClaw from compacting), or `session.resetByType.group.idleMinutes` is below 2,880 (sessions would reset before VC stores them).

Set `debug: true` for request and payload logging; disable it in production.

## Provider filtering and excluded agents

**`providers`.** The plugin checks each turn's current model against `providers` (lowercased, exact `provider/model` match). The model comes from the hook context, or from the agent's `sessions.json` when the hook does not provide it, so `/model` switches are picked up. Because the check uses the live model, the list must cover every model in the fallback chain of each agent you want to use VC: a fallback to an unlisted model turns VC off for those turns. Conversely, listing a model that an unwanted agent also uses makes that agent use VC as well; use `excludeAgents` to keep an agent out. Typed VC commands and proxy-routed runs are not subject to the filter.

**`excludeAgents`.** Matches the agent id (case-insensitive) in the session key. Excluded agents get no prepare, no ingest, no typed VC commands, and no proxy routing, and the list is logged at startup when it is not empty. Current limits: the native slash commands and the seven retrieval tools do not check this list, so an excluded agent can still reach the VC service through them.

## Security and access

This is everything the plugin sends, reads, writes, and runs.

### Network

All VC calls go to `baseUrl` and carry the VC key (`vckey`) and conversation id in the query string.

| Call | When |
|------|------|
| `POST /api/v1/context/prepare` | Every eligible turn, and every VC command except `/vcreingest`. Sends the message history (the full session history on the first prepare, afterwards the last 24 host messages by default), the model name, and turn provenance (sender, message, channel, and reply-target ids and text). |
| `POST /api/v1/context/ingest` | Every eligible completed turn. Sends the user message, the reply, and provenance. |
| `GET /api/v1/tools/definitions`, `POST /api/v1/tools/<name>` | Tool definitions and tool calls. |
| `GET /api/v1/context/capabilities`, `POST /api/v1/tools/__vc_exact_source_prepare_v2` and `__vc_exact_source_ingest_v2` | Discord guild channels with `convIdentity: "stable"`. |
| `POST <baseUrl><outboundIdCapture.latePath>` | Only with `outboundIdCapture` in carry mode with a `latePath`: the bot's outbound message ids. |
| `GET <baseUrl>/vc-<key>/dashboard/settings` | Only with `proxyMode` enabled: the health check. |
| Model calls to `https://<baseUrl host>/vc-<key>/backend-api` | Only for proxy-routed agents: the full model request, with the provider credentials the agent uses. |

Discord API calls use the bot token configured for the Discord account in `openclaw.json`:

| Call | When |
|------|------|
| `GET /channels/<id>/messages/<id>` | When a Discord reply arrives without the quoted message's text: fetches the current message, the replied-to message, and at most one parent. |
| `GET /channels/<id>` | With `discordMemoryScope`, when a channel's server is not yet known. |
| `POST /users/@me/channels`, `POST /channels/<dm>/messages` | With `operatorNoticeUserId`: sends the model-fallback notice to that user. |

### Files read

- `~/.openclaw/openclaw.json` — plugin and gateway settings (cached by modification time and size).
- `~/.openclaw/agents/<id>/sessions/sessions.json` — the session's current model, when the hook does not provide it.
- The session's transcript `~/.openclaw/agents/<id>/sessions/<session>.jsonl` — speaker names, and the full history for a session's first prepare.
- Files named in `agentKeyFiles` (any path).
- With `proxyMode.codexAgents`: `~/.openclaw/agents/<id>/agent/codex-home/config.toml`.
- With the context engine selected: history image files (up to 30 MB each) and system fonts, for image labels.
- OpenClaw's installed `reply-payload` module, loaded from the OpenClaw install directory when a command reply needs it.

### Files written

- `~/.openclaw/extensions/virtual-context/initialized-sessions.json` — always. Session ids, upload time, and message counts; no conversation content.
- `~/.openclaw/state/virtual-context/completion-outbox/` and `completion-dead-letter/` — Discord guild channels with `convIdentity: "stable"`. Each completed turn's user message, reply, and provenance are written here (directory mode `0700`, files `0600`) until the service accepts them; records that cannot be delivered within 7 days or the retry limit move to the dead-letter directory and are kept.
- `~/.openclaw/state/virtual-context/outbound-id-queue/` — with `outboundIdCapture` in carry mode: message ids only.
- `<workspace>/media/inbound/vc-labeled/` — with the context engine selected on flattening hosts: labeled image copies, capped at 256 MB.
- The `modelCallCapture` directory — only when enabled: full model inputs and outputs (directory `0700`, files `0600`).

### Processes

- With the context engine selected: runs `python3` (or `$VC_LABELER_PYTHON`) with the bundled `tools/label_image.py`, once at startup to check it works and then to label history images (10-second timeout, at most 4 at a time).

### Credentials

- The VC key (`vcKey`, or the per-agent key files), sent as described above. The plugin stores a SHA-256 hash of the key, not the key, in outbox and queue records.
- Discord bot tokens from `openclaw.json`, used only for the Discord calls above.
- In proxy mode, the agent's model provider credentials travel with its model requests to the VC proxy.

### Changes to what the model sees and what is sent

- The message history is replaced with VC's payload, and VC's system text is applied as described in [How it works](#how-it-works).
- Proxy mode switches the run's model (to its twin, or to a fallback) and adds a signed `<!-- vc:route ... -->` marker to the prompt.
- The context engine adds speaker labels and replaces history images with labeled copies.
- Outbound messages have `<!-- vc:... -->` markers removed; with `operatorNoticeUserId`, fallback notices are sent by direct message instead of in the channel.
- `debug: true` writes message previews and payloads to the gateway log.

## Getting a vcKey

Sign up at [virtual-context.com](https://virtual-context.com).

## Learn more

- [virtual-context.com](https://virtual-context.com) — product overview and signup
- [Documentation](https://virtual-context.com/docs/)
- [Research paper](https://virtual-context.com/paper/)
- [Source code](https://github.com/virtual-context/openclaw-plugin)

## Changelog

### 5.17.1

- The package now includes `proxy-mode.js`; installs from the package failed to load without it.
- Slash-command descriptions corrected: `/vcattach` attaches this session to an existing conversation, and `/vcmerge` merges this conversation into another.

### 5.17.0

- Codex agents in `proxyMode.codexAgents` can name a fallback model that runs are switched to while VC's health check fails.
- The health check runs immediately before each run of a Codex agent that has a fallback.
- Replayed history speaker tags carry each message's platform message id when the host provides one.

### 5.16.1

- The proxy health check runs at startup, so a routed agent's first turn is not sent unrouted.

### 5.16.0

- The proxy records Codex-routed turns; the plugin no longer ingests them.

### 5.15.0 – 5.15.2

- A failing history-window callback no longer breaks context assembly. (Routed agents briefly sent only a recent history tail; restored to the full history in 5.15.2.)

### 5.14.0 – 5.14.3

- `proxyMode.codexAgents`: route Codex-harness agents through VC by pointing their Codex config at the VC route. The plugin requires the VC custom provider with WebSockets disabled.

### 5.13.0 – 5.13.2

- `proxyMode.agents`: route an agent's runs through a VC twin model, validated at startup. Twin models must use SSE transport, and host re-runs of a routed turn stay routed.

### 5.12.0 – 5.12.1

- On hosts that flatten history, images stay bound to their own messages, and the current request's images are named for the model.

### 5.11.2 – 5.11.5

- The session's model is read from the hook context, and prepare sends only the last 24 host history messages by default.
- Speaker attribution is kept across native transcript formats, transcript admission fences are honored, message times survive admission, and verified reply parents are sent with turn provenance.

### 5.11.1

- `discordMemoryScope`: opt-in, per-agent server-wide memory based on verified channel membership.

### 5.11.0

- `operatorNoticeUserId`: model-fallback notices go to an operator's direct messages instead of the channel.

### 5.10.1

- The `contextTokens` startup warning now fires when the budget exceeds real model context windows.

### 5.10.0

- Host speaker labels cannot be forged: member-typed lookalikes are escaped and each request carries a nonce.

### 5.9.0 – 5.9.1

- After a compaction, the next prepare sends only the current turn.
- The current speaker is restated at the end of the prepared context.

### 5.8.0

- `outboundIdCapture`, `ingestRetry`, `agentActorIds`, and `excludeAgents` options.
- The provider filter stops using VC for a session whose model stays unresolved, and reports sessions that never pass it.

### 5.7.0

- `agentKeyFiles`: per-agent VC keys.

### 5.6.0

- Web chat conversations are keyed per user.

### 5.5.1 – 5.5.5

- A failed VC admission no longer blocks the turn.
- Discord: nested replies carry one verified parent, media captions keep attribution, native reply intent is preserved, and invocations by role mention alone are recognized.

### 5.5.0

- Discord guild turns in stable mode are stored through ordered, durable completion records bound to the native message and author; a service that cannot accept them refuses them before storing anything.
- Prepare timeout raised from 15 s to 30 s; VC commands stay at 60 s and the initial history upload at 120 s.

### 5.4.8

- Group replies are attributed correctly when the host provides no run id.

### 5.4.7

- The current speaker and native reply target are bound to the host's run, message, and sender ids. When Discord omits a quoted reply's text, the plugin fetches and verifies the same-channel target and passes it as untrusted, separately labeled context; forwarded, cross-channel, or edited targets are rejected.
- A turn ending in a delivery tool call still yields its reply text for ingest.
- Heartbeat turns are excluded.

### 5.4.3 – 5.4.6

- The plugin can be selected as OpenClaw's context engine to add speaker attribution to group-chat history.
- The current speaker is bound to the invoked turn using the host's own sender id and session row, and must agree with the turn's provenance before it is used.

### 5.3.0

- Discord channels certified for one server share one conversation, including the `conversationGroups` wildcard form.

### 5.2.0

- `convIdentity: "stable"`: conversations keyed by session key survive session resets. Cron sessions are excluded.
- `conversationGroups`: several chat scopes can share one conversation.
- Every message in a group conversation carries its speaker.
- Stored user turns contain only what the user wrote, without the host's replayed history.
- `vc_find_quote` accepts a channel scope.
- Native slash commands `/vcstatus`, `/vcmerge`, `/vclabel`, `/vcattach`, `/vcreingest`.

### 5.1.2

- A system message in VC's payload is applied as the system prompt instead of being left in the message list.
- A warning is logged when the provider filter starts skipping a session it previously passed.

### 5.1.1

- `[vc:wire]` log lines include the request timeout.

### 5.1.0

- `VCMERGE INTO <target>` support; VC commands use a 60 s timeout.

### 5.0.1

- VC command errors show the service's error text.

### 5.0.0

- Built-in tool definitions (no network call needed to register tools), VC command handling, history upload tracking with `VCREINGEST`, and request logging in debug mode.
