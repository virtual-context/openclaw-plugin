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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VC_COMMENT_RE = /<!--\s*vc:[^>]*-->/g;

// Tracks sessions where last prepare was a VC command (skip ingest)
const vcCommandSessions = new Set();

// ── JSONL ingest tracking ──
// Tracks which sessions have had their full JSONL history sent to the VC cloud.
// On first prepare for a new session, reads the entire JSONL and sends all messages.
// Subsequent calls use normal windowed messages. Reset via VCREINGEST command.
const INGEST_TRACKER_PATH = join(homedir(), ".openclaw", "extensions", "virtual-context", "initialized-sessions.json");

function readIngestTracker() {
  try { return JSON.parse(readFileSync(INGEST_TRACKER_PATH, "utf-8")); }
  catch { return {}; }
}

function writeIngestTracker(tracker) {
  writeFileSync(INGEST_TRACKER_PATH, JSON.stringify(tracker, null, 2));
}

function isSessionIngested(sessionId) {
  return sessionId in readIngestTracker();
}

function markSessionIngested(sessionId, messageCount) {
  const tracker = readIngestTracker();
  tracker[sessionId] = { ingestedAt: new Date().toISOString(), messages: messageCount };
  writeIngestTracker(tracker);
}

function resetSessionIngest(sessionId) {
  const tracker = readIngestTracker();
  delete tracker[sessionId];
  writeIngestTracker(tracker);
}

/**
 * Read the full session JSONL and extract messages in API format.
 * Returns an array of {role, content} messages, or null on failure.
 */
function readFullSessionJSONL(sessionKey, sessionId, log) {
  try {
    const parts = sessionKey?.split(":");
    if (!parts || parts.length < 2) return null;
    const agentId = parts[1];

    const jsonlPath = join(homedir(), ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);
    if (!existsSync(jsonlPath)) {
      log?.info?.(`[vc] JSONL not found: ${jsonlPath}`);
      return null;
    }

    const content = readFileSync(jsonlPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    log?.info?.(`[vc] JSONL: ${lines.length} lines (${(content.length / 1024 / 1024).toFixed(1)}MB)`);

    const messages = [];
    let skipped = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.message?.role) {
          messages.push(entry.message);
        } else if (entry.role && (entry.role === "user" || entry.role === "assistant" || entry.role === "tool")) {
          messages.push(entry);
        } else {
          skipped++;
        }
      } catch {
        skipped++;
      }
    }

    log?.info?.(`[vc] JSONL parsed — ${messages.length} messages, ${skipped} non-message entries skipped`);
    return messages.length > 0 ? messages : null;
  } catch (err) {
    log?.error?.(`[vc] JSONL read failed: ${err}`);
    return null;
  }
}

/**
 * Resolve the current provider/model for a session by reading sessions.json.
 * Returns "provider/model" lowercase, or null if unknown.
 *
 * NOTE: This reads OpenClaw's internal session store directly from disk because
 * the before_prompt_build hook context does not expose the current model.
 * This is fragile — the file format could change between OpenClaw versions.
 * The proper fix is OpenClaw exposing provider/model in the hook context.
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

async function vcPost(baseUrl, path, vcKey, sessionId, body, timeoutMs = 15000, log = null) {
  const url = buildUrl(baseUrl, path, vcKey, sessionId);
  const serialized = JSON.stringify(body);
  const byteLen = Buffer.byteLength(serialized, "utf-8");
  const msgCount = body?.messages?.length ?? 0;
  if (log) log.info?.(`[vc:wire] POST ${path} — ${msgCount} messages, ${byteLen} bytes serialized`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: serialized,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (log) log.info?.(`[vc:wire] POST ${path} — HTTP ${res.status} ${res.statusText}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`VC API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// vcGet removed — tool definitions are now hardcoded, no bootstrap network call needed.

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

    // ── Register VC retrieval tools (hardcoded definitions) ──
    // TOOLS: Registered statically — no bootstrap network call needed.
    // Update these when the VC tool catalogue changes and release a new plugin version.
    const vcTools = [
      { name: "vc_expand_topic", description: "Load the full original conversation text for a topic. Use when a topic summary covers the area you need \u2014 expanding reveals the complete conversation including details the summary may have compressed. Also use after vc_find_quote returns snippets \u2014 expand the matching tag to read surrounding context before answering. For specific facts when you don't know which topic holds them, use vc_find_quote first to locate them.", input_schema: { type: "object", properties: { tag: { type: "string", description: "Topic tag from the context-topics list to expand." }, depth: { type: "string", enum: ["segments", "full"], description: "Target depth: 'segments' for individual summaries, 'full' for original conversation text." }, collapse_tags: { type: "array", items: { type: "string" }, description: "Optional list of topic tags to collapse back to summary depth before expanding. Frees context budget in the same round-trip instead of requiring a separate tool call." } }, required: ["tag"] } },
      { name: "vc_find_quote", description: "Search the full original conversation text and truncated tool outputs for a specific word, phrase, or detail. Use this when you see '... N bytes truncated \u2014 call vc_find_quote(query) ...' in a tool result, or when the user asks about a specific fact \u2014 a name, number, dosage, recommendation, date, or decision \u2014 especially when no topic summary mentions it or you don't know which topic it falls under. This bypasses tags entirely and searches raw text, so it finds content even when it's filed under an unexpected topic. Returns short excerpts \u2014 use vc_expand_topic on a matching tag if you need more context.", input_schema: { type: "object", properties: { query: { type: "string", description: "The word or phrase to search for. Use the most specific and distinctive terms." } }, required: ["query"] } },
      { name: "vc_recall_all", description: "Load summaries of ALL stored conversation topics at once. Use when the user asks for a broad overview, wants to know everything discussed, needs a full summary, or asks a vague question that spans multiple topics. Returns all tag summaries within the token budget. After reviewing, use vc_expand_topic on specific tags if you need more detail.", input_schema: { type: "object", properties: {} } },
      { name: "vc_query_facts", description: "Query extracted facts with structured filters. Essential for questions about events, experiences, trips, activities, or anything the user has done \u2014 each fact has a date, location, and status. Also use for counting, listing, or filtering questions like 'how many X have I done', 'what projects am I leading'. Returns matching facts with count.", input_schema: { type: "object", properties: { subject: { type: "string", description: "Who the fact is about. Usually 'user'." }, verb: { type: "string", description: "Action verb to search for (e.g. 'led', 'built', 'prefers'). Automatically expanded to include similar verbs." }, object_contains: { type: "string", description: "Keyword to match in the object field." }, status: { type: "string", enum: ["active", "completed", "planned", "abandoned", "recurring"], description: "Temporal status filter. Omit for counting queries to get all statuses at once." }, fact_type: { type: "string", enum: ["personal", "experience", "world"], description: "Filter by fact type. Omit to get all types." } } } },
      { name: "vc_remember_when", description: "Best tool for time-based questions. Retrieves conversations and facts from a specific date range. Use FIRST when the question mentions a time period ('past three months', 'last week', 'in March', 'between June and July'). Returns both conversation excerpts and structured facts within the window.", input_schema: { type: "object", properties: { query: { type: "string", description: "Topic/fact query to search for within a time window." }, time_range: { type: "object", properties: { kind: { type: "string", enum: ["relative", "between_dates"] }, preset: { type: "string", enum: ["last_7_days", "last_30_days", "last_90_days", "last_week", "last_month", "this_week", "this_month"] }, start: { type: "string", description: "YYYY-MM-DD" }, end: { type: "string", description: "YYYY-MM-DD" } }, required: ["kind"] }, max_results: { type: "integer", description: "Maximum results to return (default 5)." } }, required: ["query", "time_range"] } },
      { name: "vc_restore_tool", description: "Restore compacted conversation history in place. Compacted turns marked with [Compacted turn N | ... | vc_restore_tool(ref=...)] contain the FULL original conversation including thinking blocks, tool calls, tool outputs, and all details that the summary omits. Call this when you need the exact original content.", input_schema: { type: "object", properties: { ref: { type: "string", description: "The ref from the compacted stub (e.g. chain_5_abc123 or tool_abc123def)" } }, required: ["ref"] } },
      { name: "vc_find_session", description: "Retrieve full conversation excerpts from a specific older session that was marked as superseded in a previous vc_find_quote result. Use this ONLY when you see '[Older session \u2014 superseded]' and need the original text to answer the question.", input_schema: { type: "object", properties: { query: { type: "string", description: "The word or phrase to search for within the session." }, session: { type: "string", description: "The session date to search (e.g. '2023/05/25'). Copy the date shown in the '[Older session (...)]' marker." } }, required: ["query", "session"] } },
    ];

    for (const def of vcTools) {
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
              { arguments: params },
              15000,
              debug ? log : null
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
    }
    log.info?.(`[vc] registered ${vcTools.length} tools (hardcoded)`);

    // ── before_prompt_build: prepare context ──
    // FILESYSTEM: Reads sessions.json to resolve the current model (read-only).
    // NETWORK: POST /api/v1/context/prepare — sends full message history to cloud.
    // PAYLOAD: Replaces messages in-place with the compressed payload from the cloud.
    api.on("before_prompt_build", async (event, ctx) => {
      const sessionId = ctx?.sessionId ?? "unknown";
      const sessionKey = ctx?.sessionKey ?? "";
      const promptText = (event.prompt ?? "").trim();

      // Handle VCREINGEST locally — resets the ingest tracker for this session.
      // Next prepare call will re-read the full JSONL and send all messages to the cloud.
      if (/^VCREINGEST$/i.test(promptText)) {
        resetSessionIngest(sessionId);
        log.info?.(`[vc] VCREINGEST — reset ingest tracker for session=${sessionId}`);
        vcCommandSessions.add(sessionId);
        return { prependContext: `Respond with ONLY the following text, exactly as shown. No commentary, no additions:\n\nSession ${sessionId} marked for re-ingest. The full conversation history will be sent to Virtual Context on the next message.` };
      }

      // VC commands (VCSTATUS, VCLABEL, etc.) must always reach prepare regardless
      // of provider filter. The provider filter uses the *configured* model from
      // sessions.json, but model fallback happens later — so the filter may see
      // "anthropic/claude-opus-4-6" even when the actual runtime model is GPT-5.4.
      const isVcCommand = /^VC[A-Z]/i.test(promptText);

      // Check provider filter against the session's current model
      if (providerFilter && !isVcCommand) {
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
      if (isVcCommand) {
        log.info?.(`[vc] VC command detected in prompt — bypassing provider filter`);
      }

      log.info?.(`[vc] prepare — session=${sessionId} messages=${event?.messages?.length ?? 0}`);

      // event.messages is the history (does NOT include the current user message).
      // event.prompt is the current user message. Append it so the cloud sees the
      // full conversation including the current turn — needed for VC command detection
      // and accurate context preparation.
      let messagesWithCurrentTurn = [...event.messages];
      if (event.prompt) {
        messagesWithCurrentTurn.push({
          role: "user",
          content: [{ type: "text", text: event.prompt }],
        });
      }

      // ── Initial JSONL ingest ──
      // On the first prepare call for a session not yet in the tracker,
      // read the full JSONL from disk and send ALL messages instead of
      // the windowed subset from OpenClaw. This gives the cloud the
      // complete conversation history for initial context building.
      let isInitialIngest = false;
      if (!isSessionIngested(sessionId)) {
        const fullMessages = readFullSessionJSONL(sessionKey, sessionId, log);
        if (fullMessages && fullMessages.length > messagesWithCurrentTurn.length) {
          log.info?.(`[vc] initial ingest — sending ${fullMessages.length} JSONL messages (was ${messagesWithCurrentTurn.length} windowed)`);
          messagesWithCurrentTurn = [...fullMessages];
          if (event.prompt) {
            messagesWithCurrentTurn.push({
              role: "user",
              content: [{ type: "text", text: event.prompt }],
            });
          }
          isInitialIngest = true;
        } else {
          // JSONL not available or smaller than windowed — mark as ingested anyway
          markSessionIngested(sessionId, messagesWithCurrentTurn.length);
          log.info?.(`[vc] no JSONL advantage — marked session=${sessionId} as ingested (${messagesWithCurrentTurn.length} messages)`);
        }
      }

      const prepareBody = {
        messages: messagesWithCurrentTurn,
        model: ctx?.model ?? undefined,
      };
      if (debug) {
        log.info?.(`[vc:debug] prepare request — url=${baseUrl}/api/v1/context/prepare vcconv=${sessionId} messages=${prepareBody.messages?.length ?? 0} model=${prepareBody.model ?? "?"}`);
        log.info?.(`[vc:debug] prepare first message: ${JSON.stringify(prepareBody.messages?.[0])?.slice(0, 300)}`);
        log.info?.(`[vc:debug] prepare last message: ${JSON.stringify(prepareBody.messages?.[prepareBody.messages.length - 1])?.slice(0, 300)}`);
      }

      let prepareResult;
      try {
        prepareResult = await vcPost(baseUrl, "/api/v1/context/prepare", vcKey, sessionId, prepareBody, isInitialIngest ? 120000 : 15000, log);
      } catch (err) {
        log.error?.(`[vc] prepare failed: ${err} — passing through unmodified`);
        if (debug) log.error?.(`[vc:debug] prepare error detail: ${err.stack ?? err}`);
        return;
      }

      // Mark session as ingested after successful initial ingest
      if (isInitialIngest) {
        markSessionIngested(sessionId, messagesWithCurrentTurn.length);
        log.info?.(`[vc] marked session=${sessionId} as ingested (${messagesWithCurrentTurn.length} messages sent)`);
      }

      // ── VC command handling ──
      // If the prepare response contains a vc_command, the cloud handled it server-side.
      // Do NOT modify event.messages — that persists to the session and pollutes history.
      // Instead, use prependContext to inject the command output as the prompt.
      // The LLM gets a small instruction + command output, responds quickly, ingest is skipped.
      if (prepareResult.vc_command) {
        const cmdMessage = prepareResult.message ?? `[VC ${prepareResult.vc_command}]`;
        log.info?.(`[vc] VC command: ${prepareResult.vc_command} — injecting via prependContext, skipping LLM`);
        vcCommandSessions.add(sessionId);

        return { prependContext: `Respond with ONLY the following text, exactly as shown. No commentary, no additions:\n\n${cmdMessage}` };
      }

      // Clear command flag for normal turns
      vcCommandSessions.delete(sessionId);

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

      // Return system prompt override if the prepared body includes one.
      // NOTE: This replaces the ENTIRE system prompt. VC manages the full
      // payload in order to fully compress it.
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
    // NETWORK: POST /api/v1/context/ingest — sends assistant reply text to cloud for tagging.
    api.on("agent_end", async (event, ctx) => {
      const sessionId = ctx?.sessionId ?? "unknown";
      const sessionKey = ctx?.sessionKey ?? "";

      // Skip ingest for VC command turns — command was fully handled by prepare
      if (vcCommandSessions.has(sessionId)) {
        log.info?.(`[vc] skipping ingest — VC command turn`);
        vcCommandSessions.delete(sessionId);
        return;
      }

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
        }, 15000, log);
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
