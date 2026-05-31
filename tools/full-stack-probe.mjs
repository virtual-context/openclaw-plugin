#!/usr/bin/env node
// Full-stack probe: cloud /api/v1/context/prepare → plugin hoist + normalization
// → host runtime conversion (transformTransportMessages + convertResponsesMessages)
// → POST to model API → capture response and verdict.
//
// Read-only: does not touch any agent JSONL, does not enqueue any channel reply,
// does not create persistent state.

import { readFileSync, writeFileSync } from "node:fs";
import { argv, env, exit } from "node:process";
import { hoistSystemPreamble } from "../index.js";
import { createRequire } from "node:module";

// transformTransportMessages is exported (as `_`) from the host runtime bundle
const require = createRequire(import.meta.url);
const transportBundle = require("/usr/lib/node_modules/openclaw/dist/openai-transport-stream-BkI6rJ3U.js");
const transformTransportMessages = transportBundle._;

// ─────────────────────────────────────────────────────────────────────────────
// CLI parser
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { probe: null, savedCloudBody: null, savedTelegramTurn: null, conv: null, model: "gpt-5.5", apiKey: null, outDir: "/tmp", noLlm: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--probe") args.probe = argv[++i];
    else if (a === "--saved-cloud-body") args.savedCloudBody = argv[++i];
    else if (a === "--saved-telegram-turn") args.savedTelegramTurn = argv[++i];
    else if (a === "--conv") args.conv = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--api-key") args.apiKey = argv[++i];
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--no-llm") args.noLlm = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--help" || a === "-h") { printHelp(); exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node full-stack-probe.mjs [INPUT-MODE] [OPTIONS]

Input modes (exactly one):
  --probe "<text>"               Synthesize a user turn; load history from
                                 conv's local JSONL (--conv required to
                                 resolve the agent's sessions/<conv>.jsonl).
  --saved-cloud-body <path>      Replay a captured cloud prepare response.
                                 Skips the cloud call entirely.
  --saved-telegram-turn <path>   Replay an openclaw JSONL session file as
                                 the prepare input messages.

Options:
  --conv <session-id>            Required for --probe (and used to vcconv on cloud).
                                 Default: db12d44d-afd8-43d3-a881-3a8c53e9e8b5 (perfume conv).
  --model <id>                   Model id for the LLM POST. Default: gpt-5.5.
  --api-key <key>                Override the OpenAI API key. Default: read from
                                 /root/.openclaw/agents/bastkid-dedicated/agent/auth-profiles.json
                                 → profiles["openai:manual"].token, or env OPENAI_API_KEY.
  --out-dir <dir>                Where to write the captured payloads. Default: /tmp.
  --no-llm                       Skip the LLM POST; emit only the bytes-level verdict.
  --verbose                      Verbose tracing.
  -h, --help                     Show this help.

Verdict signals:
  bytes-level — does <system-reminder> reach the LLM-bound payload?
  content-level — does the LLM response reference perfume keywords?
  tool-call — which vc_* tools did the LLM call, if any?
  perf — round-trip latency + token counts + model used.
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloud prepare client
// ─────────────────────────────────────────────────────────────────────────────

function readOpenclawConfig() {
  const cfg = JSON.parse(readFileSync("/root/.openclaw/openclaw.json", "utf-8"));
  return {
    vcKey: cfg.plugins?.entries?.["virtual-context"]?.config?.vcKey,
    baseUrl: cfg.plugins?.entries?.["virtual-context"]?.config?.baseUrl || "https://api.virtual-context.com",
  };
}

async function callCloudPrepare(inputMessages, sessionId, verbose) {
  const { vcKey, baseUrl } = readOpenclawConfig();
  const url = `${baseUrl}/api/v1/context/prepare?vckey=${encodeURIComponent(vcKey)}&vcconv=${sessionId}`;
  const body = JSON.stringify({ messages: inputMessages });
  if (verbose) console.error(`[probe] POST ${url.replace(vcKey, "***")} (${body.length} bytes, ${inputMessages.length} messages)`);
  const t0 = Date.now();
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const text = await res.text();
  const elapsedMs = Date.now() - t0;
  if (!res.ok) throw new Error(`cloud prepare HTTP ${res.status}: ${text.slice(0, 500)}`);
  if (verbose) console.error(`[probe] cloud prepare OK in ${elapsedMs}ms (${text.length} bytes response)`);
  return { rj: JSON.parse(text), elapsedMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloud body shape → host runtime internal shape
// ─────────────────────────────────────────────────────────────────────────────

function convertCloudToInternalShape(msgs) {
  return msgs.map((m) => {
    if (m.role === "user" || m.role === "system") return m;
    if (m.role === "tool") {
      const content = typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : Array.isArray(m.content) ? m.content : [];
      return { role: "toolResult", toolCallId: m.tool_call_id, content };
    }
    if (m.role === "assistant") {
      const content = Array.isArray(m.content) ? [...m.content] : [];
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          content.push({
            type: "toolCall",
            id: tc.id,
            name: (tc.function && tc.function.name) || tc.name || "?",
            arguments: (tc.function && tc.function.arguments) ?? tc.arguments ?? {},
          });
        }
      }
      return {
        role: "assistant",
        model: m.model,
        provider: m.provider,
        api: m.api,
        content,
      };
    }
    return m;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Host runtime convertResponsesMessages port (verbatim from bundle structure)
// ─────────────────────────────────────────────────────────────────────────────

function shortHash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = ((h * 31) + value.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function parseTextSignature(signature) {
  if (!signature) return;
  if (signature.startsWith("{")) try {
    const parsed = JSON.parse(signature);
    if (parsed.v === 1 && typeof parsed.id === "string") {
      return parsed.phase === "commentary" || parsed.phase === "final_answer"
        ? { id: parsed.id, phase: parsed.phase }
        : { id: parsed.id };
    }
  } catch {}
  return { id: signature };
}

const sanitize = (t) => String(t || "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
const normalizeIdPart = (p) => p.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
const buildForeignResponsesItemId = (id) => `fc_${shortHash(id)}`.slice(0, 64);

function convertResponsesMessages(model, context, allowed, options) {
  const out = [];
  const replayReason = options?.replayReasoningItems ?? true;
  const replayIds = options?.replayResponsesItemIds ?? true;
  const normalizeToolCallId = (id, _t, source) => {
    if (!allowed.has(model.provider)) return normalizeIdPart(id);
    if (!id.includes("|")) return normalizeIdPart(id);
    const [callId, itemId] = id.split("|");
    let normItemId = (source.provider !== model.provider || source.api !== model.api)
      ? buildForeignResponsesItemId(itemId)
      : normalizeIdPart(itemId);
    if (!normItemId.startsWith("fc_")) normItemId = normalizeIdPart(`fc_${normItemId}`);
    return `${normalizeIdPart(callId)}|${normItemId}`;
  };
  const transformed = transformTransportMessages(context.messages, model, normalizeToolCallId);
  if ((options?.includeSystemPrompt ?? true) && context.systemPrompt) {
    out.push({ role: model.reasoning ? "developer" : "system", content: sanitize(context.systemPrompt) });
  }
  let msgIndex = 0;
  const dropped = {};
  for (const msg of transformed) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") out.push({ role: "user", content: [{ type: "input_text", text: sanitize(msg.content) }] });
      else {
        const c = msg.content
          .map((i) => i.type === "text" ? { type: "input_text", text: sanitize(i.text) } : null)
          .filter(Boolean);
        if (c.length) out.push({ role: "user", content: c });
      }
    } else if (msg.role === "assistant") {
      const items = [];
      for (const b of msg.content) {
        if (b.type === "thinking") {
          if (replayReason && b.thinkingSignature) {
            const item = JSON.parse(b.thinkingSignature);
            if (!replayIds) delete item.id;
            items.push(item);
          }
        } else if (b.type === "text") {
          const sig = parseTextSignature(b.textSignature);
          let id = replayIds ? (sig?.id ?? `msg_${msgIndex}`) : undefined;
          if (id && id.length > 64) id = `msg_${shortHash(id)}`;
          items.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: sanitize(b.text), annotations: [] }],
            status: "completed",
            ...(id ? { id } : {}),
            phase: sig?.phase,
          });
        } else if (b.type === "toolCall") {
          const [callId, itemIdRaw] = b.id.split("|");
          items.push({
            type: "function_call",
            id: itemIdRaw,
            call_id: callId,
            name: b.name,
            arguments: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}),
          });
        }
      }
      if (items.length) out.push(...items);
    } else if (msg.role === "toolResult") {
      const txt = msg.content.filter((i) => i.type === "text").map((i) => i.text).join("\n");
      const [callId] = msg.toolCallId.split("|");
      out.push({ type: "function_call_output", call_id: callId, output: sanitize(txt || "(no output)") });
    } else {
      dropped[msg.role] = (dropped[msg.role] || 0) + 1;
    }
    msgIndex += 1;
  }
  return { items: out, dropped, transformedCount: transformed.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM call (OpenAI Responses API)
// ─────────────────────────────────────────────────────────────────────────────

function resolveApiKey(override) {
  if (override) return override;
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;
  try {
    const auth = JSON.parse(readFileSync("/root/.openclaw/agents/bastkid-dedicated/agent/auth-profiles.json", "utf-8"));
    const token = auth.profiles?.["openai:manual"]?.token;
    if (token) return token;
  } catch {}
  return null;
}

async function callOpenAI(items, model, apiKey, verbose) {
  // OpenAI Responses API: https://api.openai.com/v1/responses
  // Input: { model, input: [items], instructions: <system>, stream: false }
  // We split out the system/developer prompt from `items` since the API takes it as `instructions`.
  let instructions = "";
  const inputItems = [];
  for (const it of items) {
    if ((it.role === "system" || it.role === "developer") && typeof it.content === "string") {
      instructions = instructions ? `${instructions}\n${it.content}` : it.content;
    } else {
      inputItems.push(it);
    }
  }
  const body = JSON.stringify({ model, input: inputItems, instructions, stream: false });
  if (verbose) console.error(`[probe] POST https://api.openai.com/v1/responses model=${model} body=${body.length} bytes instructions=${instructions.length} chars input_items=${inputItems.length}`);
  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body,
  });
  const text = await res.text();
  const elapsedMs = Date.now() - t0;
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status} in ${elapsedMs}ms: ${text.slice(0, 1000)}`);
  return { rj: JSON.parse(text), elapsedMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict assembly
// ─────────────────────────────────────────────────────────────────────────────

const KEYWORDS = ["<system-reminder>", "context-topics", "perfume-preference", "perfume-recommendation", "sania-perfume", "Glossier", "JHAG", "Valaya", "Amazing Grace", "Ellis Brooklyn", "Sania"];
const VC_TOOL_NAMES = ["vc_recall_all", "vc_find_quote", "vc_expand_topic", "vc_query_facts", "vc_remember_when", "vc_restore_tool", "vc_find_session"];

function countKeywords(text) {
  const out = {};
  for (const kw of KEYWORDS) {
    const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out[kw] = (text.match(re) || []).length;
  }
  return out;
}

function extractAssistantText(rj) {
  if (!rj || !Array.isArray(rj.output)) return "";
  const parts = [];
  for (const item of rj.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
      }
    }
  }
  return parts.join("\n");
}

function extractToolCalls(rj) {
  if (!rj || !Array.isArray(rj.output)) return [];
  const calls = [];
  for (const item of rj.output) {
    if (item.type === "function_call") {
      calls.push({ name: item.name, call_id: item.call_id, arguments: item.arguments });
    }
  }
  return calls;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input acquisition (probe / saved body / saved telegram turn)
// ─────────────────────────────────────────────────────────────────────────────

function loadJsonlMessages(jsonlPath) {
  const lines = readFileSync(jsonlPath, "utf-8").split("\n");
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.type === "message" && e.message) out.push(e.message);
    } catch {}
  }
  return out;
}

async function acquireCloudBody(args) {
  if (args.savedCloudBody) {
    const rj = JSON.parse(readFileSync(args.savedCloudBody, "utf-8"));
    return { rj, prepareElapsedMs: null, source: `saved:${args.savedCloudBody}` };
  }
  const conv = args.conv || "db12d44d-afd8-43d3-a881-3a8c53e9e8b5";
  // resolve input messages
  let inputMessages;
  if (args.savedTelegramTurn) {
    inputMessages = loadJsonlMessages(args.savedTelegramTurn);
  } else if (args.probe) {
    // Load conv history from local JSONL, append the probe user turn
    const jsonlPath = `/root/.openclaw/agents/bastkid-dedicated/sessions/${conv}.jsonl`;
    inputMessages = loadJsonlMessages(jsonlPath);
    inputMessages.push({ role: "user", content: [{ type: "text", text: args.probe }], timestamp: Date.now() });
  } else {
    throw new Error("Provide --probe, --saved-cloud-body, or --saved-telegram-turn");
  }
  const { rj, elapsedMs } = await callCloudPrepare(inputMessages, conv, args.verbose);
  return { rj, prepareElapsedMs: elapsedMs, source: args.probe ? `probe:${conv}` : `saved-turn:${args.savedTelegramTurn}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(argv);
  const { rj: cloudResponse, prepareElapsedMs, source } = await acquireCloudBody(args);
  const body = cloudResponse.body || {};
  const cloudMsgCount = (body.messages || []).length;
  const cloudMsgZeroRole = body.messages?.[0]?.role;
  const cloudSystemFieldBefore = typeof body.system === "string" ? body.system.length : (body.system ? "blocks" : null);

  // Apply plugin's hoist
  const hoistedChars = hoistSystemPreamble(body);

  // Convert to host-runtime internal shape
  const internalMsgs = convertCloudToInternalShape(body.messages);
  const model = { id: args.model, provider: "openai-codex", api: "openai-codex-responses", input: ["text"], reasoning: true };
  const ctx = { messages: internalMsgs, systemPrompt: typeof body.system === "string" ? body.system : "" };
  const { items, dropped, transformedCount } = convertResponsesMessages(model, ctx, new Set(["openai-codex"]), { includeSystemPrompt: true });

  // Bytes-level: did the preamble survive into the outbound items?
  const outboundJson = JSON.stringify(items);
  const inputKeywords = countKeywords(outboundJson);

  // Optional LLM POST
  let llmResponse = null;
  let llmElapsedMs = null;
  let llmError = null;
  let assistantText = "";
  let assistantToolCalls = [];
  if (!args.noLlm) {
    const apiKey = resolveApiKey(args.apiKey);
    if (!apiKey) {
      llmError = "No OpenAI API key resolved (set --api-key, OPENAI_API_KEY, or populate auth-profiles.json openai:manual.token)";
    } else {
      try {
        const r = await callOpenAI(items, args.model, apiKey, args.verbose);
        llmResponse = r.rj;
        llmElapsedMs = r.elapsedMs;
        assistantText = extractAssistantText(llmResponse);
        assistantToolCalls = extractToolCalls(llmResponse);
      } catch (err) {
        llmError = String(err.message || err);
      }
    }
  }

  // Content-level: keyword grep on the assistant response text
  const responseKeywords = assistantText ? countKeywords(assistantText) : {};

  // Persist artifacts
  const tsTag = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const cloudPath = `${args.outDir}/probe-${tsTag}-cloud-body.json`;
  const itemsPath = `${args.outDir}/probe-${tsTag}-outbound-items.json`;
  const llmPath = `${args.outDir}/probe-${tsTag}-llm-response.json`;
  writeFileSync(cloudPath, JSON.stringify(cloudResponse, null, 2));
  writeFileSync(itemsPath, JSON.stringify(items, null, 2));
  if (llmResponse) writeFileSync(llmPath, JSON.stringify(llmResponse, null, 2));

  // Verdict block
  const calledVcTool = assistantToolCalls.some((c) => VC_TOOL_NAMES.includes(c.name));
  const preambleInOutbound = inputKeywords["<system-reminder>"] >= 1 && inputKeywords["context-topics"] >= 1;
  const responseReferencesPerfume = ["Glossier", "JHAG", "Valaya", "Amazing Grace", "Ellis Brooklyn", "Sania"]
    .some((kw) => (responseKeywords[kw] || 0) > 0);

  const verdict = {
    source,
    timestamps: { startedAt: new Date().toISOString() },
    cloud: {
      conv_id: cloudResponse.conversation_id,
      is_passthrough: cloudResponse.is_passthrough,
      tags_matched: cloudResponse.tags_matched,
      body_messages_count: cloudMsgCount,
      messages_0_role_pre_hoist: cloudMsgZeroRole,
      body_system_pre_hoist: cloudSystemFieldBefore,
      prepare_elapsed_ms: prepareElapsedMs,
    },
    plugin: {
      hoist_applied: hoistedChars ? true : false,
      hoist_chars: hoistedChars || 0,
      body_messages_count_post_hoist: body.messages.length,
      body_system_chars_post_hoist: typeof body.system === "string" ? body.system.length : null,
    },
    host_runtime: {
      transformed_messages: transformedCount,
      outbound_items: items.length,
      dropped_roles: dropped,
    },
    bytes_level: {
      preamble_keywords_in_outbound: inputKeywords,
      preamble_survived_to_llm: preambleInOutbound,
    },
    llm: args.noLlm ? "skipped (--no-llm)" : {
      model: args.model,
      error: llmError,
      elapsed_ms: llmElapsedMs,
      usage: llmResponse?.usage || null,
      assistant_text_head: assistantText.slice(0, 500),
      assistant_text_length: assistantText.length,
      tool_calls: assistantToolCalls.map((c) => ({ name: c.name, args: c.arguments?.slice?.(0, 120) ?? c.arguments })),
    },
    content_level: {
      perfume_keywords_in_response: responseKeywords,
      response_references_perfume: responseReferencesPerfume,
      called_vc_tool: calledVcTool,
    },
    artifacts: { cloud_body: cloudPath, outbound_items: itemsPath, llm_response: llmResponse ? llmPath : null },
  };

  console.log(JSON.stringify(verdict, null, 2));
}

main().catch((e) => { console.error("[probe] fatal:", e.message); console.error(e.stack); exit(1); });
