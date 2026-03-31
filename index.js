/**
 * virtual-context — OpenClaw lifecycle plugin (v5)
 *
 * Full Virtual Context integration via REST API.
 *
 * Bootstrap (on register):
 *   GET /api/v1/tools/definitions?vckey=KEY
 *   → Registers each VC tool via api.registerTool()
 *
 * Lifecycle hooks (every LLM turn):
 *   before_prompt_build → POST /api/v1/context/prepare
 *     → Sends the full payload (messages, system, model, etc.)
 *     → Receives complete enriched body back
 *     → Replaces messages in-place, returns system prompt override
 *   llm_input → observability logging
 *   agent_end → POST /api/v1/context/ingest
 *     → Sends assistant_message string for tagging + compaction
 *
 * Tool execution (when LLM requests a VC tool):
 *   POST /api/v1/tools/{tool_name}?vckey=KEY&vcconv=SESSION
 *     → Passes arguments through, returns result string
 *
 * Config (openclaw.json plugins.entries.virtual-context.config):
 *   vcKey    — Virtual Context API key
 *   baseUrl  — VC REST API base URL (default: https://api.virtual-context.com)
 *   providers — array of "provider/model" strings to activate for (e.g. ["openai-direct/gpt-5.4"])
 *              If empty or omitted, activates for all providers.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VC_COMMENT_RE = /<!--\s*vc:[^>]*-->/g;

/**
 * Resolve the current provider/model for a session by reading sessions.json.
 * Returns "provider/model" lowercase, or null if unknown.
 */
function resolveSessionModel(sessionKey) {
  try {
    // Extract agentId from sessionKey: "agent:<agentId>:..."
    const parts = sessionKey?.split(":");
    if (!parts || parts.length < 2) return null;
    const agentId = parts[1];
    const storePath = join(homedir(), ".openclaw", "agents", agentId, "sessions", "sessions.json");
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    const entry = store[sessionKey];
    if (!entry?.modelProvider || !entry?.model) return null;
    return `${entry.modelProvider}/${entry.model}`.toLowerCase();
  } catch {
    return null;
  }
}

function buildUrl(baseUrl, path, vcKey, sessionId) {
  const base = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const params = [`vckey=${encodeURIComponent(vcKey)}`];
  if (sessionId) params.push(`vcconv=${encodeURIComponent(sessionId)}`);
  return `${base}?${params.join("&")}`;
}

async function vcPost(baseUrl, path, vcKey, sessionId, body) {
  const url = buildUrl(baseUrl, path, vcKey, sessionId);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`VC API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function vcGet(baseUrl, path, vcKey) {
  const url = buildUrl(baseUrl, path, vcKey, null);
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`VC API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export default {
  id: "virtual-context",
  name: "Virtual Context",
  description:
    "Full context window management via Virtual Context REST API",
  kind: "lifecycle",

  register(api) {
    const log = api.logger ?? console;
    const cfg = api.pluginConfig ?? {};
    const vcKey = cfg.vcKey || "";
    const baseUrl = cfg.baseUrl || "https://api.virtual-context.com";
    const providerFilter = Array.isArray(cfg.providers) && cfg.providers.length > 0
      ? new Set(cfg.providers.map((p) => p.toLowerCase()))
      : null; // null = all providers
    const debug = cfg.debug === true;

    if (!vcKey) {
      log.warn?.("[vc] no vcKey configured — plugin disabled");
      return;
    }

    log.info?.(`[vc] register() v5 — baseUrl=${baseUrl} debug=${debug} providers=${providerFilter ? [...providerFilter].join(",") : "all"}`);

    // ── Config compatibility checks ──
    const ocConfig = api.config ?? {};
    const defaults = ocConfig.agents?.defaults ?? {};

    const pruningMode = defaults.contextPruning?.mode;
    if (pruningMode && pruningMode !== "off") {
      log.warn?.(`[vc] WARNING: agents.defaults.contextPruning.mode is "${pruningMode}" — should be "off". OpenClaw may prune messages before VC sees them. Set contextPruning.mode to "off" and let VC manage the context window.`);
    }

    const contextTokens = defaults.contextTokens;
    if (typeof contextTokens === "number" && contextTokens < 1000000) {
      log.warn?.(`[vc] WARNING: agents.defaults.contextTokens is ${contextTokens} — recommend 2000000+. Low values cause early compaction before VC can manage the context.`);
    }

    const groupIdleMinutes = ocConfig.session?.resetByType?.group?.idleMinutes;
    if (typeof groupIdleMinutes === "number" && groupIdleMinutes < 2880) {
      log.warn?.(`[vc] WARNING: session.resetByType.group.idleMinutes is ${groupIdleMinutes} — recommend 2880+ (48h). Low values reset sessions and wipe client-side history before VC can manage it.`);
    }

    // ── Bootstrap: fetch tool definitions and register each one ──
    vcGet(baseUrl, "/api/v1/tools/definitions", vcKey)
      .then((data) => {
        const tools = data?.tools ?? [];
        log.info?.(`[vc] bootstrap — ${tools.length} tool(s)`);
        if (debug) log.info?.(`[vc:debug] bootstrap response: ${JSON.stringify(data).slice(0, 500)}`);

        for (const def of tools) {
          api.registerTool((ctx) => ({
            name: def.name,
            description: def.description,
            parameters: def.input_schema,
            async execute(toolCallId, params) {
              const sessionId = ctx?.sessionId ?? "unknown";
              log.info?.(`[vc] tool call — ${def.name} session=${sessionId}`);
              if (debug) log.info?.(`[vc:debug] tool ${def.name} request: ${JSON.stringify(params).slice(0, 500)}`);

              try {
                const response = await vcPost(
                  baseUrl,
                  `/api/v1/tools/${def.name}`,
                  vcKey,
                  sessionId,
                  { arguments: params }
                );
                if (debug) log.info?.(`[vc:debug] tool ${def.name} response: ${(response.result ?? "").slice(0, 500)}`);
                return {
                  content: [{ type: "text", text: response.result ?? "" }],
                };
              } catch (err) {
                log.error?.(`[vc] tool ${def.name} failed: ${err}`);
                return {
                  content: [{ type: "text", text: `Error: ${err.message}` }],
                };
              }
            },
          }));

          log.info?.(`[vc] registered tool: ${def.name}`);
        }
      })
      .catch((err) => {
        log.error?.(`[vc] bootstrap failed — no tools registered: ${err}`);
      });

    // ── before_prompt_build: prepare context ──
    api.on("before_prompt_build", async (event, ctx) => {
      const sessionId = ctx?.sessionId ?? "unknown";
      const sessionKey = ctx?.sessionKey ?? "";

      // Check provider filter against the session's current model
      if (providerFilter) {
        const currentModel = resolveSessionModel(sessionKey);
        if (currentModel && !providerFilter.has(currentModel)) {
          log.info?.(`[vc] skipping — ${currentModel} not in provider filter`);
          return;
        }
        // If model unknown (new session), proceed — better to prepare and not need it
        // than to skip and send an unenriched payload
        if (!currentModel && debug) {
          log.info?.(`[vc:debug] model not yet in session store, proceeding optimistically`);
        }
      }

      log.info?.(`[vc] prepare — session=${sessionId} messages=${event?.messages?.length ?? 0}`);

      const prepareBody = {
        messages: event.messages,
        model: ctx?.model ?? undefined,
      };
      if (debug) {
        log.info?.(`[vc:debug] prepare request — url=${baseUrl}/api/v1/context/prepare vcconv=${sessionId} messages=${event.messages?.length ?? 0} model=${prepareBody.model ?? "?"}`);
        log.info?.(`[vc:debug] prepare first message: ${JSON.stringify(event.messages?.[0])?.slice(0, 300)}`);
        log.info?.(`[vc:debug] prepare last message: ${JSON.stringify(event.messages?.[event.messages.length - 1])?.slice(0, 300)}`);
      }

      let prepareResult;
      try {
        prepareResult = await vcPost(baseUrl, "/api/v1/context/prepare", vcKey, sessionId, prepareBody);
      } catch (err) {
        log.error?.(`[vc] prepare failed: ${err} — passing through unmodified`);
        if (debug) log.error?.(`[vc:debug] prepare error detail: ${err.stack ?? err}`);
        return;
      }

      const body = prepareResult.body;
      const passthrough = prepareResult.is_passthrough ?? false;
      const meta = prepareResult.metadata ?? {};

      log.info?.(
        `[vc] prepare OK — conversation=${prepareResult.conversation_id ?? "?"} ` +
        `passthrough=${passthrough} ` +
        `tags=${(meta.tags_matched ?? []).length} tokens_added=${meta.tokens_added ?? 0}`
      );
      if (debug) {
        log.info?.(`[vc:debug] prepare response body.messages=${body?.messages?.length ?? "none"} body.system=${typeof body?.system === "string" ? body.system.length + " chars" : Array.isArray(body?.system) ? body.system.length + " blocks" : "none"}`);
        log.info?.(`[vc:debug] prepare metadata: ${JSON.stringify(meta).slice(0, 500)}`);
      }

      if (!body) return;

      // Replace messages in-place with the enriched payload's messages
      if (Array.isArray(body.messages) && Array.isArray(event.messages)) {
        // Normalize messages for OpenClaw compatibility.
        // OpenClaw's pi-coding-agent accesses these properties without null checks:
        //   - assistant.usage.input/output/cacheRead/cacheWrite/cost.total (agent-session.js ~2209)
        //   - assistant.content.filter/flatMap/length (agent-session.js ~2208, ~2313)
        //   - message.content must be an array, never null
        const defaultUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        for (const msg of body.messages) {
          if (msg?.role === "assistant") {
            if (!msg.usage) msg.usage = { ...defaultUsage, cost: { ...defaultUsage.cost } };
            if (!msg.content) msg.content = [];
            if (!Array.isArray(msg.content)) msg.content = [{ type: "text", text: String(msg.content) }];
          }
          if (msg && msg.content === null) msg.content = [];
        }
        event.messages.length = 0;
        event.messages.push(...body.messages);
        log.info?.(`[vc] replaced messages — ${body.messages.length} from prepared body`);
      }

      // Return system prompt override if the prepared body includes one
      const system = body.system;
      if (typeof system === "string" && system.length > 0) {
        log.info?.(`[vc] system prompt override — ${system.length} chars`);
        return { systemPrompt: system };
      }
      // Anthropic format: system can be an array of content blocks
      if (Array.isArray(system) && system.length > 0) {
        const text = system
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        if (text.length > 0) {
          log.info?.(`[vc] system prompt override — ${text.length} chars (from blocks)`);
          return { systemPrompt: text };
        }
      }
    });

    // ── llm_input: observability ──
    api.on("llm_input", (event, ctx) => {
      const sessionId = ctx?.sessionId ?? "unknown";
      log.info?.(
        `[vc] llm_input — session=${sessionId} provider=${event?.provider ?? "?"}/${event?.model ?? "?"} ` +
        `messages=${event?.historyMessages?.length ?? 0} images=${event?.imagesCount ?? 0} ` +
        `systemPrompt=${event?.systemPrompt?.length ?? 0} chars`
      );
    });

    // ── agent_end: ingest the completed turn ──
    api.on("agent_end", async (event, ctx) => {
      const sessionId = ctx?.sessionId ?? "unknown";
      const sessionKey = ctx?.sessionKey ?? "";

      // Same provider filter as prepare
      if (providerFilter) {
        const currentModel = resolveSessionModel(sessionKey);
        if (currentModel && !providerFilter.has(currentModel)) return;
      }

      const allMessages = event?.messages ?? [];

      // Extract the last assistant message text
      let assistantMessage = "";
      for (let i = allMessages.length - 1; i >= 0; i--) {
        const msg = allMessages[i];
        if (msg?.role === "assistant") {
          const content = msg.content;
          if (typeof content === "string") {
            assistantMessage = content;
          } else if (Array.isArray(content)) {
            assistantMessage = content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n");
          }
          break;
        }
      }

      if (!assistantMessage) return;

      log.info?.(`[vc] ingest — session=${sessionId} assistant_message=${assistantMessage.length} chars`);
      if (debug) log.info?.(`[vc:debug] ingest request — assistant_message preview: ${assistantMessage.slice(0, 300)}`);

      try {
        const ingestResult = await vcPost(baseUrl, "/api/v1/context/ingest", vcKey, sessionId, {
          assistant_message: assistantMessage,
        });
        log.info?.(
          `[vc] ingest OK — conversation=${ingestResult.conversation_id ?? "?"} ` +
          `status=${ingestResult.status ?? "?"} ` +
          `compaction=${ingestResult.compaction_triggered ?? false}`
        );
        if (debug) log.info?.(`[vc:debug] ingest response: ${JSON.stringify(ingestResult).slice(0, 500)}`);
      } catch (err) {
        log.error?.(`[vc] ingest failed: ${err}`);
        if (debug) log.error?.(`[vc:debug] ingest error detail: ${err.stack ?? err}`);
      }
    });

    // ── Strip vc comment tags from outbound messages ──
    api.on("message_sending", async (event) => {
      if (!event?.content) return;
      VC_COMMENT_RE.lastIndex = 0;
      const stripped = event.content.replace(VC_COMMENT_RE, "").trim();
      if (stripped !== event.content) {
        return { content: stripped };
      }
    });
  },
};
