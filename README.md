# [Virtual Context](https://virtual-context.com) Plugin for OpenClaw

> **[virtual-context.com](https://virtual-context.com)** — OS-style memory for LLMs. Less context. Better answers.

Persistent AI memory across conversations. [Virtual Context](https://virtual-context.com) sits between your agent and the LLM provider, enriching every request with relevant context from past conversations. No code changes needed for proxy mode; this plugin provides deep integration via the REST API.

## What It Does

- **Prepare** — before each LLM call, sends your messages to the Virtual Context cloud. Gets back an enriched payload with relevant historical context injected.
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
2. **Before each LLM call** — calls `/api/v1/context/prepare` with the full message history. The cloud returns an enriched payload with context injected, old turns trimmed, and tools added. The plugin replaces the messages in-place.
3. **After each LLM response** — calls `/api/v1/context/ingest` with the assistant's reply text for tagging and compaction
4. **On tool calls** — when the LLM requests a VC tool, the plugin calls `/api/v1/tools/{name}` and returns the result

## Provider Filtering

By default, the plugin activates for all providers. Use the `providers` config to restrict it to specific provider/model combinations. The plugin reads the current model from the session store at runtime, so it correctly handles `/model` switches.

## Getting a vcKey

Sign up at [virtual-context.com](https://virtual-context.com) to get your API key. Free tier available with 1 conversation and 50 requests/day. Pro ($29/mo) for unlimited.

## Learn More

- [virtual-context.com](https://virtual-context.com) — product overview, pricing, and signup
- [Documentation](https://virtual-context.com/docs/) — integration guides for Anthropic, OpenAI, and more
- [Research Paper](https://virtual-context.com/paper/) — the technical paper behind Virtual Context
- [GitHub](https://github.com/virtual-context/openclaw-plugin) — plugin source code
