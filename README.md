# [Virtual Context](https://virtual-context.com) Plugin for OpenClaw

> **[virtual-context.com](https://virtual-context.com)** — OS-style memory for LLMs. Less context. Better answers.

[Virtual Context](https://virtual-context.com) lets your agents run with unlimited context windows while sending only what matters to the LLM. Conversations are compressed, organized, and indexed automatically. When context is needed, it's retrieved semantically and injected into the payload. The result: unlimited memory, lower token costs, and better reasoning from models that see clean, relevant context instead of raw history.

This plugin provides deep OpenClaw integration via the Virtual Context REST API. For other frameworks, the [transparent proxy](https://virtual-context.com/docs/) requires zero code changes.

## What It Does

- **Prepare** — before each LLM call, sends your messages to the Virtual Context cloud. Gets back an compressed payload with relevant historical context injected.
- **Tools** — registers retrieval tools (`vc_expand_topic`, `vc_find_quote`, `vc_recall_all`, `vc_query_facts`, `vc_remember_when`, `vc_find_session`) that the LLM can call to pull in more context on demand.
- **Ingest** — after each LLM response, sends the assistant's reply to the cloud for tagging and indexing.

## Installation

```
openclaw plugins install clawhub:virtual-context
```

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "virtual-context": {
        "enabled": true,
        "config": {
          "vcKey": "vc-your-key-here",
          "baseUrl": "https://api.virtual-context.com",
          "providers": ["openai-direct/gpt-5.4"],
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
| `vcKey` | string | required | Your Virtual Context API key |
| `baseUrl` | string | `https://api.virtual-context.com` | VC REST API base URL |
| `providers` | string[] | all | Provider/model pairs to activate for. Empty = all providers. Example: `["openai-direct/gpt-5.4"]` |
| `debug` | boolean | `false` | Enable verbose logging of REST API calls and payloads |
| `modelCallCapture` | object | disabled | Store complete, untruncated `llm_input` and `llm_output` hook payloads in a bounded local gzip log. Defaults to 512 MiB, 2,000 files, and 7 days under `~/.openclaw/logs/virtual-context/model-calls`. |

## How It Works

1. **Bootstrap** — on startup, fetches tool definitions from `/api/v1/tools/definitions` and registers them as OpenClaw tools
2. **Before each LLM call** — calls `/api/v1/context/prepare` with the full message history. The cloud returns an compressed payload with context injected, old turns trimmed, and tools added. The plugin replaces the messages in-place.
3. **After each LLM response** — calls `/api/v1/context/ingest` with the assistant's reply text for tagging and compaction
4. **On tool calls** — when the LLM requests a VC tool, the plugin calls `/api/v1/tools/{name}` and returns the result

## Provider Filtering

By default, the plugin activates for all providers. Use the `providers` config to restrict it to specific provider/model combinations. The plugin reads the current model from the session store at runtime, so it correctly handles `/model` switches.

## Security and Access

This plugin is transparent about what it accesses. Here is the full list:

**Network calls (to your configured `baseUrl`):**
- Sends conversation messages to `/api/v1/context/prepare` before each LLM call
- Sends assistant reply text to `/api/v1/context/ingest` after each LLM response
- Fetches tool definitions from `/api/v1/tools/definitions` at startup
- Calls `/api/v1/tools/{name}` when the LLM requests a retrieval tool

**Local filesystem reads:**
- Reads `~/.openclaw/agents/<agentId>/sessions/sessions.json` to determine the current model for provider filtering. This is a read-only access to OpenClaw's session store, used because the `before_prompt_build` hook does not expose the active model in its context. No writes.
- Reads the active session JSONL to recover Discord speaker names that OpenClaw omits from model-facing history objects.

**Model-call capture (opt-in, off by default):**
- Writes one atomic mode-`0600` gzip JSON file for every `llm_input` and `llm_output` event.
- Captures every field exposed by OpenClaw's `llm_input`/`llm_output` hooks—including complete system prompt, user prompt, local history messages, output, usage, and run/session/provider correlation—without the built-in trajectory's string truncation.
- Enforces total compressed bytes, file count, and age on every write. The directory is mode `0700`.
- Contains conversation content. Restrict access accordingly.
- OpenClaw does not expose provider request bytes, tool definitions/images, or state retained inside a persistent provider thread through these hooks. The capture records that limitation and can be correlated by `runId`/`sessionId` with OpenClaw's trajectory `threadId`; it does not falsely claim to materialize provider-side state.

**Payload modification:**
- Replaces the message array in-place with the compressed payload returned by the cloud
- Can override the system prompt if the cloud returns one (VC manages the full payload to compress it)

**Tool registration:**
- Registers tools dynamically from definitions fetched from the cloud at startup

**Debug logging (opt-in, off by default):**
- When `debug: true`, logs message previews, API responses, and payload sizes to the gateway log. Disable in production.

**What it does NOT do:**
- Does not write local payload files unless `modelCallCapture.enabled` is explicitly set to `true`
- Does not read files outside the session store; opt-in captures are written only to the configured capture directory
- Does not send data to any endpoint other than your configured `baseUrl`
- Does not store credentials or API keys beyond what is in your `openclaw.json` config

## Getting a vcKey

Sign up at [virtual-context.com](https://virtual-context.com) to get your API key. Free tier available. Pro ($19/mo) for unlimited.

## Learn More

- [virtual-context.com](https://virtual-context.com) — product overview, pricing, and signup
- [Documentation](https://virtual-context.com/docs/) — integration guides for Anthropic, OpenAI, and more
- [Research Paper](https://virtual-context.com/paper/) — the technical paper behind Virtual Context
- [GitHub](https://github.com/virtual-context/openclaw-plugin) — plugin source code

## Changelog

### 5.4.6

- **Invoked-turn current-speaker proof**: group turns now capture OpenClaw's channel-owned `senderId` at `before_agent_reply`, bind it to the exact session, session key, and normalized request hash, and require it to agree with the structured current-turn actor provenance before VC receives an actor id or the model receives a `<current-speaker>` boundary. History-only context-engine passes retain that same-turn proof rather than clearing it. This applies only when Vast is invoked; unrelated channel messages, direct messages, stored history, and actor-card write policy are unchanged.

### 5.4.5

- **Current-speaker identity at the authoritative lifecycle seam**: the selected context engine now hands the exact trailing current turn's trusted `senderName`/`senderId` to the later prompt hook through a short-lived, body-hash-bound in-memory record. This supplies structured actor provenance to VC and binds any returned actor card without waiting for the current row to be written to session JSONL. Only invoked model turns pass through this seam; unrelated Discord messages, DMs, stored transcripts, and actor-card write policy are unchanged.

### 5.4.4

- **Exact current-speaker binding without a prompt envelope**: invoked group turns can bind the current speaker's actor card from the newest OpenClaw-owned session row when `before_prompt_build` omits channel identity. The row must be the newest user row, its body must exactly match the current request, and its sender id, name, and platform must be valid; any independently available prompt or hook identity must agree. Direct messages, older-row searches, canonical history, and actor-card writes are unchanged.

### 5.4.3

- **Speaker-attributed native group history**: when selected with `plugins.slots.contextEngine: "virtual-context"`, the plugin preserves OpenClaw's legacy context-engine lifecycle and stock compaction while adding trusted `senderName`/`senderId` attribution to the in-memory group-chat history that OpenClaw renders as `<conversation_context>`. Discord DMs and direct sessions are unchanged, missing metadata is never guessed, and stored OpenClaw/VC conversation text is not rewritten.

### 5.1.1

- **Wire-log observability**: the `[vc:wire] POST <path>` log line now appends `timeout=Nms` so the prepare-call timeout selection is grep-able from gateway logs. VCMERGE / VCMERGE PREVIEW requests show `timeout=60000ms`, normal prepares show `timeout=15000ms`, and initial JSONL ingest shows `timeout=120000ms`.
- **Wire-shape tests strengthened** to pin the full prepare-payload body shape (role, content[].type, model presence/absence) for both `VCMERGE INTO` and `VCMERGE PREVIEW`, not just message count + prompt text.
- **Lockfile regenerated** to record 5.1.1 (runtime payload was unaffected because `package.json` `"files"` excludes the lockfile).

### 5.1.0

- **VCMERGE support**: the plugin's existing `^VC[A-Z]/i + vc_command + prependContext` rail handles `VCMERGE INTO <target>`, `VCMERGE PREVIEW <target>`, and the reserved-for-v2 `VCMERGESTATUS <merge_id>` natively. No new dispatch code; cloud's REST endpoint resolves these alongside VCATTACH/VCSTATUS/VCLABEL/etc.
- **Timeout sizing for VC commands**: prepare-call timeout is now `60s` for any VC command (matches against `^VC[A-Z]/i`). Previous behavior was `15s` everywhere except `120s` on initial JSONL ingest. This gives sync-path merges comfortable headroom — VCMERGE on conversations >5k turns may take several seconds (sync path); >10k turns return a `merge_id` immediately for async tracking via `VCMERGESTATUS`.
  - **Alarm-threshold rule**: the 60s cap is a forcing function, NOT a tuning knob. If real-world p99 nears 60s, the right lever is dropping cloud's `max_sync_source_turns` to push more sources into the async path — NOT bumping this timeout further. Bumping past 60s would mask the sync-path getting too slow rather than escalating it.
- **Test infrastructure**: the plugin now ships a `vitest` + `fetch-mock` test harness in `tests/`. Tests cover the timeout-per-branch contract, URL+body construction, and the message/error/bracket fallback chain over canonical error envelopes. Run via `npm test`. Dev-only: `tests/` and `node_modules/` do not bundle into the runtime npm package (per `package.json` `"files"`); end-user installs are unchanged.

### 5.0.1

- Defensive fix: VC command error responses now render correctly when the cloud populates the `error` field without a `message` field. Previously, error responses (such as `VCATTACH` against a missing target) rendered the placeholder string `[VC <command>]` and the user saw no error context. The plugin now falls back to `prepareResult.error` before the placeholder.

### 5.0.0

- Hardcoded retrieval tool definitions (no bootstrap network call).
- VC command handling via `prependContext` (keeps history clean).
- JSONL ingest tracking with `VCREINGEST` reset command.
- Wire-level request logging in debug mode.
