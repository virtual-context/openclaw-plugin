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
          "debug": false
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

**Payload modification:**
- Replaces the message array in-place with the compressed payload returned by the cloud
- Can override the system prompt if the cloud returns one (VC manages the full payload to compress it)

**Tool registration:**
- Registers tools dynamically from definitions fetched from the cloud at startup

**Debug logging (opt-in, off by default):**
- When `debug: true`, logs message previews, API responses, and payload sizes to the gateway log. Disable in production.

**What it does NOT do:**
- Does not write to any local files (except gateway logs via the logger)
- Does not access files outside the session store
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
