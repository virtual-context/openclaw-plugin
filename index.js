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

import {
  readFileSync, writeFileSync, existsSync,
  statSync, openSync, readSync, closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VC_COMMENT_RE = /<!--\s*vc:[^>]*-->/g;

// Tracks sessions where last prepare was a VC command (skip ingest)
const vcCommandSessions = new Set();

// sessionId -> the user text this turn's prepare sent to the cloud.
//
// The cloud pairs a turn's user half with its assistant half, but those arrive
// on two separate requests minutes apart, and the memory holding the user half
// in between belongs to whichever worker served prepare. When that memory dies
// — a restart, an eviction, a differently-routed ingest — the cloud is left
// with an assistant and no user, refuses to store a half-turn, and the turn is
// lost from memory entirely. The plugin is the one component that holds both
// halves, so it carries the user text forward and sends it with the reply.
//
// It must be the text prepare actually sent (speaker label included), or the
// cloud would hash it as a different message and store the turn twice.
const pendingUserTurn = new Map();
// Host message id that pendingUserTurn's value came from, so a stale entry
// left by an earlier turn is never mistaken for this turn's user half.
const pendingUserTurnMessage = new Map();

// sessionKey -> last model string that PASSED the provider filter (see noteFilterResult)
const filterPassState = new Map();

// ── Host runtime suppression marker (lazy) ──
// The suppression-delivery helper lives in the gateway dist under a
// hash-suffixed filename that changes per release, at a prefix that differs per
// host. Resolve it lazily by scanning known dist roots; outside a gateway host
// (unit tests, dev) fall back to identity so replies still deliver, just without
// the suppression marking.
let _suppressionMarkerPromise = null;
function loadSuppressionMarker(log) {
  if (!_suppressionMarkerPromise) {
    _suppressionMarkerPromise = (async () => {
      const roots = [
        "/usr/lib/node_modules/openclaw/dist",
        "/opt/homebrew/lib/node_modules/openclaw/dist",
        "/usr/local/lib/node_modules/openclaw/dist",
      ];
      for (const root of roots) {
        try {
          const { readdirSync } = await import("node:fs");
          const file = readdirSync(root).find((f) => /^reply-payload-.*\.js$/.test(f));
          if (!file) continue;
          const mod = await import(join(root, file));
          if (typeof mod.r === "function") return mod.r;
          const named = Object.values(mod).find((v) => typeof v === "function");
          if (named) return named;
        } catch { /* try next root */ }
      }
      log?.warn?.("[vc] reply-payload suppression marker not found in gateway dist — replies deliver unmarked");
      return (payload) => payload;
    })();
  }
  return _suppressionMarkerPromise;
}


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

// ── Reply-only invocation fail-safe ──────────────────────────────────────
// A native Discord reply whose body is just the bot mention ("@Vast") carries
// its real request in the replied-to message, not in the message text. The
// host delivers this correctly: the current-turn envelope marks the reply and
// includes the replied-to body. It also leaves the bare mention as the final
// current-message text, though, and the model can treat that mention as the
// operative request even when the reply target is present elsewhere.
//
// For this one message shape, make the relationship explicit: the reply target
// is the request to answer. VC enrichment is still skipped so it cannot replace
// the host's native reply-bearing prompt, while prependContext removes the
// ambiguity that previously produced generic greetings.
//
// Detection prefers the host's STRUCTURED fields: the current-turn envelope is
// a labeled "Conversation info (untrusted metadata)" JSON block carrying
// `has_reply_context` / `reply_to_id`. String matching is only the fallback
// for locating that block.

const _CONV_INFO_LABEL = "Conversation info (untrusted metadata):";
const _REPLY_TARGET_LABEL =
  "Reply target of current user message (untrusted, for context):";
const _REPLY_CHAIN_LABEL =
  "Reply chain of current user message (untrusted, nearest first):";
const _CURRENT_TURN_LABELS = [
  _CONV_INFO_LABEL,
  _REPLY_TARGET_LABEL,
  _REPLY_CHAIN_LABEL,
  "Chat history since last reply (untrusted, for context):",
];
const _REPLY_ONLY_DIRECTIVE_TTL_MS = 5 * 60 * 1000;
const _replyOnlyDirectiveCache = new Map();

// The provider adapter wraps the turn before this plugin is ever called: it
// prepends a replay of earlier turns and marks the real message with a trailing
// label. Stored verbatim, that replay becomes a canonical turn holding sixty
// turns' worth of duplicated text, which then matches almost every retrieval
// query and buries the actual messages.
const _ASSEMBLED_CONTEXT_LABEL = "OpenClaw assembled context for this turn:";
const _CURRENT_REQUEST_LABEL = "Current user request:";
const _REPLAY_CLOSE_TAG = "</conversation_context>";

// A third scaffold block, emitted by the host itself rather than the provider
// adapter, and placed after the request label so it survives that split. Unlike
// the metadata headers it is not fenced JSON — it is a run of numbered history
// lines — so the fence-based strip cannot see it.
const _HISTORY_BLOCK_LABEL =
  "Conversation context (untrusted, chronological, selected for current message):";
const _HISTORY_LINE_RE = /^#\d+\s+\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

/** Parse the fenced JSON block following one of the host's prompt labels. */
export function parseLabeledJsonBlock(promptText, label) {
  const text = typeof promptText === "string" ? promptText : "";
  const at = text.indexOf(label);
  if (at < 0) return null;
  const fence = text.indexOf("```json", at);
  if (fence < 0) return null;
  const start = text.indexOf("\n", fence);
  if (start < 0) return null;
  const end = text.indexOf("```", start + 1);
  if (end < 0) return null;
  try {
    return JSON.parse(text.slice(start + 1, end).trim());
  } catch {
    return null;
  }
}

/** The host's structured conversation-info object for the current turn, or null. */
export function parseConversationInfo(promptText) {
  return parseLabeledJsonBlock(promptText, _CONV_INFO_LABEL);
}

/** The nearest replied-to message body supplied by the host, or an empty string. */
export function replyTargetBody(promptText) {
  const target = parseLabeledJsonBlock(promptText, _REPLY_TARGET_LABEL);
  if (typeof target?.body === "string" && target.body.trim()) {
    return target.body.trim();
  }

  const chain = parseLabeledJsonBlock(promptText, _REPLY_CHAIN_LABEL);
  if (Array.isArray(chain)) {
    const nearest = chain.find(
      (entry) => typeof entry?.body === "string" && entry.body.trim(),
    );
    if (nearest) return nearest.body.trim();
  }
  return "";
}

/** The actual user-typed body: the current-turn text with the host's labeled
 *  untrusted-metadata blocks removed. */
export function currentMessageBody(promptText) {
  let text = typeof promptText === "string" ? promptText : "";
  for (const label of _CURRENT_TURN_LABELS) {
    const at = text.indexOf(label);
    if (at < 0) continue;
    const fenceStart = text.indexOf("```", at);
    if (fenceStart < 0) continue;
    const fenceEnd = text.indexOf("```", fenceStart + 3);
    if (fenceEnd < 0) continue;
    text = text.slice(0, at) + text.slice(fenceEnd + 3);
  }
  return text.trim();
}

/**
 * Drop the host's numbered chat-history block, keeping the text around it.
 *
 * Only the unbroken run of numbered lines after the label is removed, so the
 * user's own message — which follows that run and is not numbered — survives.
 */
export function stripHistoryBlock(text) {
  const at = text.indexOf(_HISTORY_BLOCK_LABEL);
  if (at < 0) return text;
  const before = text.slice(0, at);
  const lines = text.slice(at + _HISTORY_BLOCK_LABEL.length).split("\n");
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || _HISTORY_LINE_RE.test(lines[i].trim()))) {
    i += 1;
  }
  return `${before}\n${lines.slice(i).join("\n")}`.trim();
}

/**
 * The turn as the user actually wrote it, with the host's assembled-context
 * replay and labeled metadata blocks removed.
 *
 * The adapter emits the replay first and the real message last, after
 * _CURRENT_REQUEST_LABEL. The split anchors on the END of the replay container
 * rather than its header, because replayed turns can themselves contain the
 * request label — a quoted mention of it, or a previously stored turn that was
 * polluted before this stripping existed. Anchoring on the header and taking
 * the first match would split inside the replay and keep the rest of it.
 *
 * The outermost close is the last one, so nesting cannot fool it.
 *
 * Fails open. If the replay is present but no anchor is found, the host format
 * has changed, and returning the text unchanged costs fidelity on one turn
 * where dropping it would cost the turn.
 */
export function currentTurnBody(promptText) {
  const text = typeof promptText === "string" ? promptText : "";
  const replayAt = text.indexOf(_ASSEMBLED_CONTEXT_LABEL);
  if (replayAt >= 0) {
    const closeAt = text.lastIndexOf(_REPLAY_CLOSE_TAG);
    const searchFrom = closeAt >= 0 ? closeAt + _REPLAY_CLOSE_TAG.length : replayAt;
    const labelAt = text.indexOf(_CURRENT_REQUEST_LABEL, searchFrom);
    if (labelAt >= 0) {
      return stripHistoryBlock(
        currentMessageBody(text.slice(labelAt + _CURRENT_REQUEST_LABEL.length)),
      );
    }
  }
  return stripHistoryBlock(currentMessageBody(text));
}

/**
 * The leading labelled metadata blocks, verbatim, or an empty string.
 *
 * Only blocks ahead of the host's replay are taken. Blocks inside the replay
 * describe older turns, not this one.
 */
export function leadingEnvelope(promptText) {
  const text = typeof promptText === "string" ? promptText : "";
  const replayAt = text.indexOf(_ASSEMBLED_CONTEXT_LABEL);
  const limit = replayAt >= 0 ? replayAt : text.length;
  let end = 0;
  for (;;) {
    let next = -1;
    for (const label of _CURRENT_TURN_LABELS) {
      const at = text.indexOf(label, end);
      if (at >= 0 && at < limit && (next < 0 || at < next)) next = at;
    }
    if (next < 0) break;
    const fence = text.indexOf("```", next);
    if (fence < 0 || fence >= limit) break;
    const fenceEnd = text.indexOf("```", fence + 3);
    if (fenceEnd < 0 || fenceEnd >= limit) break;
    end = fenceEnd + 3;
  }
  return end > 0 ? text.slice(0, end) : "";
}

/**
 * What this turn should be sent to the cloud as.
 *
 * The replay and the numbered history are removed here because they are
 * duplicates of turns already stored and nothing downstream can undo them. The
 * leading metadata envelope is deliberately kept: the engine parses it for the
 * sender, message id, channel and reply target, and strips it from the stored
 * text itself. Removing it here threw that provenance away and left the engine
 * nothing to attribute the turn with.
 */
export function currentTurnForIngest(promptText) {
  const body = currentTurnBody(promptText);
  const envelope = leadingEnvelope(promptText);
  if (!envelope) return body;
  if (!body) return envelope;
  return `${envelope.trimEnd()}\n\n${body}`;
}

/** True when a body is only a bot mention (or empty) — no request of its own. */
function isBareMentionOrEmpty(body) {
  const stripped = (typeof body === "string" ? body : "")
    .replace(/<@!?\d+>/g, " ")   // raw Discord mention
    .replace(/@[\w.\-]+/g, " ")   // resolved @Name mention
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length === 0;
}

/** True when the current turn is a native reply (structured signal). */
export function hasReplyContext(promptText) {
  const info = parseConversationInfo(promptText);
  if (!info) return false;
  return info.has_reply_context === true
    || (typeof info.reply_to_id === "string" && info.reply_to_id.trim().length > 0);
}

/**
 * Whether VC should keep its hands off the current turn.
 *
 * True only for the proven failure shape: the turn is a reply AND the typed
 * body is nothing but a mention, so the real request lives in the reply
 * target. An inline question, a reply that also types a real question, and an
 * ordinary non-reply message all return false and are enriched normally.
 *
 * The body must be derived with the wrapper-aware helper. The host wraps the
 * turn before this plugin sees it, so testing the metadata-stripped text alone
 * left the quoted replay in the body, which never looks like a bare mention.
 * That silently disabled this whole path on every real reply-only turn.
 */
export function isReplyOnlyInvocation(promptText) {
  if (!hasReplyContext(promptText)) return false;
  return isBareMentionOrEmpty(currentTurnBody(promptText));
}

/**
 * An explicit model instruction for the ambiguous "reply + bare mention" form.
 * JSON encoding keeps the user-supplied request visibly delimited without
 * inventing an XML/Markdown delimiter that the request itself could close.
 */
export function buildReplyOnlyDirective(promptText) {
  if (!isReplyOnlyInvocation(promptText)) return "";
  const targetBody = replyTargetBody(promptText);
  if (!targetBody) return "";
  return [
    "The current user invoked you by replying to a message with only your mention.",
    "Treat the replied-to message below as the current user request and answer it directly.",
    "Do not greet the user or ask what they need merely because the new message is only a mention.",
    `Replied-to request: ${JSON.stringify(targetBody)}`,
  ].join("\n");
}

/**
 * Resolve the directive across repeated prompt-build passes for one message.
 *
 * The Codex Discord harness builds the prompt twice. The first pass's
 * prependContext is folded into the second pass, which means the second prompt
 * no longer looks like a bare mention and buildReplyOnlyDirective() returns an
 * empty string. Cache by the host-generated message id so the same directive
 * is returned on every build of that message, without leaking into the next
 * Discord turn.
 */
export function resolveReplyOnlyDirective(promptText, sessionId = "", now = Date.now()) {
  for (const [key, entry] of _replyOnlyDirectiveCache) {
    if (entry.expiresAt <= now) _replyOnlyDirectiveCache.delete(key);
  }

  const info = parseConversationInfo(promptText);
  const messageId = typeof info?.message_id === "string"
    ? info.message_id.trim()
    : "";
  const key = messageId ? `${sessionId}:${messageId}` : "";
  const fresh = buildReplyOnlyDirective(promptText);

  if (fresh) {
    if (key) {
      _replyOnlyDirectiveCache.set(key, {
        directive: fresh,
        expiresAt: now + _REPLY_ONLY_DIRECTIVE_TTL_MS,
      });
    }
    return fresh;
  }

  if (!key) return "";
  return _replyOnlyDirectiveCache.get(key)?.directive ?? "";
}

/** Test-only state reset; harmless if called by external diagnostics. */
export function clearReplyOnlyDirectiveCache() {
  _replyOnlyDirectiveCache.clear();
}

/**
 * Whether VC's prepared body is unusable for a reply turn.
 *
 * A reply's real request lives in the current turn, so on a reply turn a
 * malformed prepared body (no usable messages to install) must not be pushed
 * over the host's native, reply-bearing prompt. Non-reply turns keep their
 * existing tolerance for VC returning system-only enrichment.
 */
export function preparedBodyUnusableForReply(promptText, body) {
  if (!hasReplyContext(promptText)) return false;
  if (!body || typeof body !== "object") return true;
  return !Array.isArray(body.messages) || body.messages.length === 0;
}

// ── Speaker labeling for multi-party chats ──────────────────────────────
// In a group chat the model is handed every prior human turn as a bare
// `user` message: OpenClaw strips senderName before the prompt hook runs
// (verified — a history entry arrives as {role, content, timestamp,
// __openclaw}). Distinct people therefore collapse into one anonymous
// speaker, and the agent reads whatever the last human said as the words of
// whoever is speaking now. The session JSONL is the one surface that still
// carries `senderName`, so identity is recovered from there and stamped
// into the message text, which is the only channel the model actually reads.
//
// The current inbound message is already present in the JSONL when this hook
// runs, so a message is labeled on its FIRST pass and keeps that exact text
// on every later pass. That matters beyond tidiness: the memory layer
// content-hashes each message to recognize it again, so a message that
// changed shape between turns would be stored twice.

const SPEAKER_JSONL_TAIL_BYTES = 512 * 1024;

/** Plain text of a message body, whichever content shape it uses. */
function speakerMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/** A copy of `msg` whose leading text block is replaced with `text`. */
function withSpeakerText(msg, text) {
  if (typeof msg.content === "string") return { ...msg, content: text };
  if (Array.isArray(msg.content)) {
    const content = msg.content.slice();
    const i = content.findIndex((b) => b?.type === "text");
    if (i >= 0) content[i] = { ...content[i], text };
    else content.unshift({ type: "text", text });
    return { ...msg, content };
  }
  return msg;
}

/**
 * Map a session's user-message text to the name of whoever wrote it.
 *
 * Reads only the tail of the JSONL so a long session cannot turn every turn
 * into a full-file scan; a message older than that window simply goes
 * unlabeled. Text that two different people have written verbatim is dropped
 * from the map entirely: leaving such a message unlabeled is honest, whereas
 * guessing between two speakers would invent exactly the misattribution this
 * whole mechanism exists to prevent.
 */
export function readSpeakerNames(sessionKey, sessionId, log) {
  try {
    const agentId = (sessionKey ?? "").split(":")[1];
    if (!agentId) return null;
    const jsonlPath = join(
      homedir(), ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`,
    );
    if (!existsSync(jsonlPath)) return null;

    const size = statSync(jsonlPath).size;
    const start = Math.max(0, size - SPEAKER_JSONL_TAIL_BYTES);
    const fd = openSync(jsonlPath, "r");
    let raw;
    try {
      const buf = Buffer.allocUnsafe(size - start);
      readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
    // A mid-file start almost certainly lands inside a line; drop the partial.
    const lines = raw.split("\n").filter(Boolean);
    if (start > 0) lines.shift();

    const byText = new Map();
    const ambiguous = new Set();
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = entry?.message ?? entry;
      if (msg?.role !== "user") continue;
      const name = typeof msg.senderName === "string" ? msg.senderName.trim() : "";
      if (!name) continue;
      const text = speakerMessageText(msg.content).trim();
      if (!text) continue;
      const seen = byText.get(text);
      if (seen && seen !== name) {
        ambiguous.add(text);
        continue;
      }
      byText.set(text, name);
    }
    for (const text of ambiguous) byText.delete(text);
    return byText.size > 0 ? byText : null;
  } catch (err) {
    log?.info?.(`[vc] speaker-name read failed: ${err}`);
    return null;
  }
}

/**
 * Prefix each user message with the name of whoever wrote it.
 *
 * Returns a new array; the caller's message objects are not mutated. A
 * conversation with fewer than two known speakers is left exactly as it was,
 * so one-on-one chats send a byte-identical payload. Already-labeled text is
 * left alone, which makes repeat passes over the same history a no-op.
 */
export function labelSpeakers(messages, names, log) {
  if (!names || new Set(names.values()).size < 2) return messages;
  let labeled = 0;
  const out = messages.map((msg) => {
    if (msg?.role !== "user") return msg;
    const text = speakerMessageText(msg.content);
    const name = names.get(text.trim());
    if (!name || text.startsWith(`${name}: `)) return msg;
    labeled++;
    return withSpeakerText(msg, `${name}: ${text}`);
  });
  if (labeled) {
    log?.info?.(
      `[vc] speaker-labeled ${labeled} message(s) across ` +
      `${new Set(names.values()).size} speakers`,
    );
  }
  return out;
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

/**
 * Track per-session provider-filter outcomes so a session that previously
 * PASSED the filter and is now being skipped produces exactly one loud
 * transition signal (silent-degradation class: e.g. an auth failure flips the
 * serving model to one outside the allowlist and memory quietly turns off).
 *
 * state: Map<sessionKey, lastPassingModel>. Returns {transition, lastPassed}.
 * A pass records the model. A skip after a recorded pass clears the record and
 * reports transition=true once; further skips stay quiet until the next pass.
 * Pure against the injected state map; exported for unit testing.
 */
export function noteFilterResult(state, sessionKey, model, passed) {
  const lastPassed = state.get(sessionKey) ?? null;
  if (passed) {
    state.set(sessionKey, model);
    return { transition: false, lastPassed };
  }
  if (lastPassed !== null) {
    state.delete(sessionKey);
    return { transition: true, lastPassed };
  }
  return { transition: false, lastPassed: null };
}

/**
 * Derive the VC conversation identity for a session.
 *
 * Durable chat scopes get a stable, human-readable conversation id (`sk:` +
 * sessionKey) that survives OpenClaw session-UUID rotation. Cron runs,
 * subagent spawns, and explicit (disposable) sessions are ephemeral by
 * design. Anything missing or outside the known table falls
 * back to the per-session UUID with a fallbackReason the caller is expected to
 * count and warn on — unknown scope shapes must never be wildcarded into
 * stable ids (a new scope family requires a table entry and a test).
 *
 * Structural tokens are matched case-sensitively, exactly as OpenClaw emits
 * them; the full sessionKey (including the leading agent namespace) is
 * preserved verbatim so two agents sharing a peer id never collide.
 *
 * Subagent and cron scopes return non-warning fallback reasons for caller
 * observability; explicit sessions are ephemeral without a fallback reason.
 *
 * Pure function; exported for unit testing.
 * Returns { convId, isStable, fallbackReason? }.
 */
export function deriveConvIdentity(sessionKey, sessionId, groupIndex) {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return { convId: sessionId, isStable: false, fallbackReason: "missing_session_key" };
  }
  // Conversation grouping: a member session key adopts its group key's stable
  // identity so multiple sessions share one VC conversation. The index only
  // contains entries validated by buildConversationGroupIndex (both sides
  // derive stable), so remapping here cannot stabilize an ephemeral scope.
  const groupKey = groupIndex?.get(sessionKey);
  if (groupKey) {
    return { convId: `sk:${groupKey}`, isStable: true };
  }
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || !parts[1]) {
    return { convId: sessionId, isStable: false, fallbackReason: "unparseable_session_key" };
  }
  const scope = parts.slice(2);
  const stable = (key) => ({ convId: `sk:${key}`, isStable: true });

  if (scope.length === 1 && scope[0] === "main") return stable(sessionKey);
  if (scope.length === 3 && scope[0] === "telegram" &&
      ["direct", "group", "slash"].includes(scope[1]) && scope[2]) {
    return stable(sessionKey);
  }
  if (scope.length === 3 && scope[0] === "discord" &&
      ["channel", "guild", "direct", "group"].includes(scope[1]) && scope[2]) {
    return stable(sessionKey);
  }
  if (scope[0] === "cron" && scope[1]) {
    // Crons are intentionally ephemeral: cron traffic runs on models outside
    // the VC provider allowlist by design, so prepare/ingest never fire for
    // them and a stable per-job identity would be dead config. Recognized
    // shapes (with or without the :run:<runUuid> suffix) stay per-session
    // without a warning; anything else cron-ish is unparseable.
    if (scope.length === 2 || (scope.length === 4 && scope[2] === "run" && scope[3])) {
      return { convId: sessionId, isStable: false, fallbackReason: "cron" };
    }
    return { convId: sessionId, isStable: false, fallbackReason: "unparseable_session_key" };
  }
  if (scope.length === 2 && scope[0] === "subagent" && scope[1]) {
    return { convId: sessionId, isStable: false, fallbackReason: "subagent" };
  }
  if (scope.length === 2 && scope[0] === "explicit" && scope[1]) {
    return { convId: sessionId, isStable: false };
  }
  return { convId: sessionId, isStable: false, fallbackReason: "unparseable_session_key" };
}

/**
 * Build the member->group index for the conversationGroups config.
 *
 * Config shape: { "<groupSessionKey>": ["<memberSessionKey>", ...], ... }.
 * Every member session key adopts the group key's stable conversation id, so
 * all grouped sessions read and write one VC conversation.
 *
 * Both sides must derive stable on their own: grouping can widen a stable
 * scope but must never stabilize an ephemeral one (cron/subagent/explicit),
 * which would bleed disposable traffic into a durable conversation. Invalid
 * groups and members are skipped with a warning; a member claimed by two
 * groups keeps its first assignment.
 *
 * Pure given (config, logger); exported for unit testing.
 */
export function buildConversationGroupIndex(groupsCfg, log) {
  const index = new Map();
  if (groupsCfg === undefined || groupsCfg === null) return index;
  if (typeof groupsCfg !== "object" || Array.isArray(groupsCfg)) {
    log?.warn?.("[vc] conversationGroups: expected an object of groupKey -> member[] — config ignored");
    return index;
  }
  for (const [groupKey, members] of Object.entries(groupsCfg)) {
    if (!deriveConvIdentity(groupKey, "probe").isStable) {
      log?.warn?.(`[vc] conversationGroups: group key ${JSON.stringify(groupKey)} does not derive a stable identity — group ignored`);
      continue;
    }
    if (!Array.isArray(members)) {
      log?.warn?.(`[vc] conversationGroups: members of ${JSON.stringify(groupKey)} must be an array — group ignored`);
      continue;
    }
    for (const member of members) {
      if (typeof member !== "string" || !deriveConvIdentity(member, "probe").isStable) {
        log?.warn?.(`[vc] conversationGroups: member ${JSON.stringify(member)} of ${JSON.stringify(groupKey)} does not derive a stable identity — member ignored`);
        continue;
      }
      if (member === groupKey) continue;
      const existing = index.get(member);
      if (existing && existing !== groupKey) {
        log?.warn?.(`[vc] conversationGroups: member ${JSON.stringify(member)} already grouped under ${JSON.stringify(existing)} — keeping first assignment`);
        continue;
      }
      index.set(member, groupKey);
    }
  }
  return index;
}

/**
 * Build a fully-qualified VC REST URL with vckey + optional vcconv query params.
 * opts.predecessor, when present, is appended (encoded) after vcconv — the
 * forward-link hint sent on stable prepares only (see deriveConvIdentity).
 * Pure function; exported for unit testing.
 */
export function buildUrl(baseUrl, path, vcKey, convId, opts = {}) {
  const base = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const params = [`vckey=${encodeURIComponent(vcKey)}`];
  if (convId) params.push(`vcconv=${encodeURIComponent(convId)}`);
  if (opts.predecessor) params.push(`predecessor=${encodeURIComponent(opts.predecessor)}`);
  return `${base}?${params.join("&")}`;
}

/**
 * Choose the prepare-call timeout based on which path is firing.
 * - VC commands (VCMERGE, VCATTACH, VCMERGE PREVIEW, etc.) get 60s. Sync-path merges
 *   are designed to land within a few seconds for the largest realistic source, so 60s
 *   is generous comfort margin. The 60s cap is ALSO a forcing function: if real-world
 *   p99 nears 60s, the right lever is dropping cloud's `max_sync_source_turns` to push
 *   into the async path, NOT bumping this timeout further.
 * - Initial JSONL ingest gets 120s. The cloud has to chew through the full session
 *   history on first contact; varies with conversation size.
 * - Everything else stays at 15s. Preserves the historical default; tight enough to
 *   fail-fast on transient cloud issues.
 *
 * Pure function; exported for unit testing.
 */
export function selectPrepareTimeout({ isVcCommand = false, isInitialIngest = false } = {}) {
  if (isVcCommand) return 60000;
  if (isInitialIngest) return 120000;
  return 15000;
}

/**
 * Render the user-facing text for a cloud-resolved VC command response.
 * The cloud envelope shape is `{vc_command, message?, error?}`. Plugin clients render
 * via `prependContext`, so we need a non-empty string. Fallback chain:
 *   1. `message`: primary, human-readable text from the cloud.
 *   2. `error`:   defense-in-depth fallback for envelopes that ship an error code
 *                 without a corresponding `message` field.
 *   3. `[VC <command>]`: last-ditch placeholder if both fields are absent.
 *
 * Pure function; exported for unit testing.
 */
export function renderVcCommandMessage(prepareResult) {
  return (
    prepareResult?.message ??
    prepareResult?.error ??
    `[VC ${prepareResult?.vc_command ?? "?"}]`
  );
}

/**
 * Hoist a leading role:"system" entry in body.messages into body.system.
 *
 * The /api/v1/context/prepare response may carry a system preamble (e.g.
 * `<system-reminder>` / `<context-topics>` tag summaries) as the first
 * entry in body.messages with role:"system" instead of placing it in the
 * dedicated body.system field. The host runtime that consumes this body
 * has no handler for role:"system" inputs in the messages array and
 * silently drops them, so the preamble never reaches the model.
 *
 * Mutates `body` in place: shifts the leading system entry out of
 * body.messages and appends its text into body.system. When body.system
 * is already populated, concatenates: newline-joined strings, or
 * block-array append for Anthropic-shaped content. Returns the number
 * of characters hoisted, or undefined when no hoist was performed.
 *
 * Pure function; exported for unit testing.
 */
export function hoistSystemPreamble(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return;
  const first = body.messages[0];
  if (!first || first.role !== "system") return;
  const c = first.content;
  const text = typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
      : "";
  if (!text) return;
  body.messages.shift();
  if (typeof body.system === "string" && body.system.length > 0) {
    body.system = body.system + "\n" + text;
  } else if (Array.isArray(body.system) && body.system.length > 0) {
    body.system = [...body.system, { type: "text", text }];
  } else {
    body.system = text;
  }
  return text.length;
}

export async function vcPost(baseUrl, path, vcKey, convId, body, timeoutMs = 15000, log = null, urlOpts = {}) {
  const url = buildUrl(baseUrl, path, vcKey, convId, urlOpts);
  const serialized = JSON.stringify(body);
  const byteLen = Buffer.byteLength(serialized, "utf-8");
  const msgCount = body?.messages?.length ?? 0;
  if (log) log.info?.(`[vc:wire] POST ${path} — ${msgCount} messages, ${byteLen} bytes serialized, timeout=${timeoutMs}ms`);
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

export async function vcGet(baseUrl, path, vcKey, convId, timeoutMs = 8000, log = null) {
  const url = buildUrl(baseUrl, path, vcKey, convId);
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  if (log) log.info?.(`[vc:wire] GET ${path} — HTTP ${res.status}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`VC API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Per-conversation tool-definition cache. The server binds a request-local
// speaker enum into eligible tool schemas from the conversation's current
// roster snapshot; hardcoded definitions remain the fail-open baseline
// whenever the fetch is stale, failing, or the feature is disabled.
const toolDefsCache = new Map(); // convId -> { byName: Map, fetchedAt }
const TOOL_DEFS_TTL_MS = 60_000;
const toolDefsInflight = new Set();

export function maybeRefreshToolDefs(baseUrl, vcKey, convId, log = null) {
  if (!convId) return;
  const entry = toolDefsCache.get(convId);
  if (entry && Date.now() - entry.fetchedAt < TOOL_DEFS_TTL_MS) return;
  if (toolDefsInflight.has(convId)) return;
  toolDefsInflight.add(convId);
  vcGet(baseUrl, "/api/v1/tools/definitions", vcKey, convId, 8000, null)
    .then((resp) => {
      const byName = new Map();
      for (const tdef of resp?.tools ?? []) {
        if (tdef?.name) byName.set(tdef.name, tdef);
      }
      toolDefsCache.set(convId, { byName, fetchedAt: Date.now() });
    })
    .catch((err) => {
      const prior = toolDefsCache.get(convId)?.byName ?? new Map();
      toolDefsCache.set(convId, { byName: prior, fetchedAt: Date.now() });
      log?.info?.(`[vc] tool definitions refresh failed for ${convId}: ${err.message}`);
    })
    .finally(() => toolDefsInflight.delete(convId));
}

export function cachedToolDef(convId, name) {
  return toolDefsCache.get(convId)?.byName?.get(name);
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

    // Conversation identity mode. Defensive even with schema validation: anything
    // other than the literal "stable" behaves as "session" (exact legacy behavior)
    // and unexpected values log a config warning once here at register.
    const stableMode = cfg.convIdentity === "stable";
    if (cfg.convIdentity !== undefined && !["session", "stable"].includes(cfg.convIdentity)) {
      log.warn?.(`[vc] WARNING: convIdentity="${cfg.convIdentity}" is not "session"|"stable" — treating as "session"`);
    }

    // In stable mode, count ephemeral fallbacks for scopes that SHOULD be stable
    // (missing/unparseable sessionKey). Intentional ephemeral scopes (subagent,
    // explicit) never warn. In session mode derivation is bypassed entirely.
    // Conversation grouping (stable mode only): validated member->group index.
    const groupIndex = stableMode
      ? buildConversationGroupIndex(cfg.conversationGroups, log)
      : new Map();
    if (!stableMode && cfg.conversationGroups !== undefined) {
      log.warn?.("[vc] WARNING: conversationGroups requires convIdentity=\"stable\" — config ignored");
    }

    let fallbackWarnCount = 0;
    function selectConvId(sessionKey, sessionId) {
      if (!stableMode) return { convId: sessionId, isStable: false };
      const identity = deriveConvIdentity(sessionKey, sessionId, groupIndex);
      if (identity.fallbackReason === "missing_session_key" || identity.fallbackReason === "unparseable_session_key") {
        fallbackWarnCount++;
        (log.warn ?? log.info)?.(
          `[vc] WARN ephemeral conv-id fallback (${identity.fallbackReason}) — ` +
          `session=${sessionId} sessionKey=${JSON.stringify(sessionKey ?? "")} ` +
          `count=${fallbackWarnCount} this boot. This scope is getting per-UUID conv ` +
          `identity; if systematic, a caller is not passing sessionKey.`
        );
      }
      return identity;
    }

    if (!vcKey) {
      log.warn?.("[vc] no vcKey configured — plugin disabled");
      return;
    }

    log.info?.(`[vc] register() v5 — baseUrl=${baseUrl} debug=${debug} convIdentity=${stableMode ? "stable" : "session"} groupedSessions=${groupIndex.size} providers=${providerFilter ? [...providerFilter].join(",") : "all"}`);

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
      { name: "vc_find_quote", description: "Search the full original conversation text and truncated tool outputs for a specific word, phrase, or detail. Use this when you see '... N bytes truncated \u2014 call vc_find_quote(query) ...' in a tool result, or when the user asks about a specific fact \u2014 a name, number, dosage, recommendation, date, or decision \u2014 especially when no topic summary mentions it or you don't know which topic it falls under. This bypasses tags entirely and searches raw text, so it finds content even when it's filed under an unexpected topic. Returns short excerpts \u2014 use vc_expand_topic on a matching tag if you need more context.", input_schema: { type: "object", properties: { query: { type: "string", description: "The word or phrase to search for. Use the most specific and distinctive terms." }, channel: { type: "string", description: "Optional source-channel scope for conversations that span multiple channels (e.g. a Discord server). Pass the channel name ('#vasttest') or id when the user asks what was said in a specific channel. Omit for normal searches." } }, required: ["query"] } },
      { name: "vc_recall_all", description: "Load summaries of ALL stored conversation topics at once. Use when the user asks for a broad overview, wants to know everything discussed, needs a full summary, or asks a vague question that spans multiple topics. Returns all tag summaries within the token budget. After reviewing, use vc_expand_topic on specific tags if you need more detail.", input_schema: { type: "object", properties: {} } },
      { name: "vc_query_facts", description: "Query extracted facts with structured filters. Essential for questions about events, experiences, trips, activities, or anything the user has done \u2014 each fact has a date, location, and status. Also use for counting, listing, or filtering questions like 'how many X have I done', 'what projects am I leading'. Returns matching facts with count.", input_schema: { type: "object", properties: { subject: { type: "string", description: "Who the fact is about. Usually 'user'." }, verb: { type: "string", description: "Action verb to search for (e.g. 'led', 'built', 'prefers'). Automatically expanded to include similar verbs." }, object_contains: { type: "string", description: "Keyword to match in the object field." }, status: { type: "string", enum: ["active", "completed", "planned", "abandoned", "recurring"], description: "Temporal status filter. Omit for counting queries to get all statuses at once." }, fact_type: { type: "string", enum: ["personal", "experience", "world"], description: "Filter by fact type. Omit to get all types." } } } },
      { name: "vc_remember_when", description: "Best tool for time-based questions. Retrieves conversations and facts from a specific date range. Use FIRST when the question mentions a time period ('past three months', 'last week', 'in March', 'between June and July'). Returns both conversation excerpts and structured facts within the window.", input_schema: { type: "object", properties: { query: { type: "string", description: "Topic/fact query to search for within a time window." }, time_range: { type: "object", properties: { kind: { type: "string", enum: ["relative", "between_dates"] }, preset: { type: "string", enum: ["last_7_days", "last_30_days", "last_90_days", "last_week", "last_month", "this_week", "this_month"] }, start: { type: "string", description: "YYYY-MM-DD" }, end: { type: "string", description: "YYYY-MM-DD" } }, required: ["kind"] }, max_results: { type: "integer", description: "Maximum results to return (default 5)." } }, required: ["query", "time_range"] } },
      { name: "vc_restore_tool", description: "Restore compacted conversation history in place. Compacted turns marked with [Compacted turn N | ... | vc_restore_tool(ref=...)] contain the FULL original conversation including thinking blocks, tool calls, tool outputs, and all details that the summary omits. Call this when you need the exact original content.", input_schema: { type: "object", properties: { ref: { type: "string", description: "The ref from the compacted stub (e.g. chain_5_abc123 or tool_abc123def)" } }, required: ["ref"] } },
      { name: "vc_find_session", description: "Retrieve full conversation excerpts from a specific older session that was marked as superseded in a previous vc_find_quote result. Use this ONLY when you see '[Older session \u2014 superseded]' and need the original text to answer the question.", input_schema: { type: "object", properties: { query: { type: "string", description: "The word or phrase to search for within the session." }, session: { type: "string", description: "The session date to search (e.g. '2023/05/25'). Copy the date shown in the '[Older session (...)]' marker." } }, required: ["query", "session"] } },
    ];

    for (const def of vcTools) {
      api.registerTool((ctx) => {
        const factorySession = ctx?.sessionId ?? "unknown";
        const factoryIdentity = selectConvId(ctx?.sessionKey ?? "", factorySession);
        maybeRefreshToolDefs(baseUrl, vcKey, factoryIdentity.convId, log);
        const fetched = cachedToolDef(factoryIdentity.convId, def.name);
        return {
        name: def.name,
        description: fetched?.description ?? def.description,
        parameters: fetched?.input_schema ?? def.input_schema,
        async execute(toolCallId, params) {
          const sessionId = ctx?.sessionId ?? "unknown";
          const identity = selectConvId(ctx?.sessionKey ?? "", sessionId);
          log.info?.(`[vc] tool call — ${def.name} session=${sessionId} conv=${identity.convId}`);
          if (debug) log.info?.(`[vc:debug] tool ${def.name} request: ${JSON.stringify(params).slice(0, 500)}`);

          try {
            const response = await vcPost(
              baseUrl,
              `/api/v1/tools/${def.name}`,
              vcKey,
              identity.convId,
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
      };
      }, { names: [def.name] });
    }
    log.info?.(`[vc] registered ${vcTools.length} tools (dynamic schemas, hardcoded fallback)`);

    // ── Native slash commands (/vcstatus, /vcmerge, /vclabel, /vcattach, /vcreingest) ──
    // Use api.registerCommand so each channel (Telegram, Discord, etc.) auto-registers
    // the slash commands and routes invocations through the native-command pipeline,
    // which auto-delivers the handler's returned {text} to the originating channel.
    // This bypasses the prepend-context+LLM round-trip used by the prompt-text intercept
    // hook below — important for agent-mode bots (Bast) whose harness only delivers via
    // the message tool, where prepend-context responses are stranded in the assistant
    // turn and never sent to the user.
    if (typeof api.registerCommand !== "function") {
      log.info?.("[vc] gateway does not expose registerCommand — native slash commands skipped");
    } else {
    const vcSlashCommands = [
      { name: "vcstatus", description: "Show VC conversation status (ingest, watermarks, tokens).", acceptsArgs: false, cmd: "VCSTATUS" },
      { name: "vcmerge",  description: "Merge VC tags (e.g. /vcmerge PREVIEW or /vcmerge tag1 tag2 ...).", acceptsArgs: true,  cmd: "VCMERGE"  },
      { name: "vclabel",  description: "Set or update conversation label (e.g. /vclabel My Project).",     acceptsArgs: true,  cmd: "VCLABEL"  },
      { name: "vcattach", description: "Attach a tag/topic to the VC conversation (/vcattach <tag>).",     acceptsArgs: true,  cmd: "VCATTACH" },
    ];
    for (const def of vcSlashCommands) {
      api.registerCommand({
        name: def.name,
        description: def.description,
        acceptsArgs: def.acceptsArgs,
        handler: async (ctx) => {
          const sessionId = ctx?.sessionId ?? ctx?.sessionKey ?? "unknown";
          const identity = selectConvId(ctx?.sessionKey ?? "", sessionId);
          const args = (ctx?.args ?? "").trim();
          const promptText = args ? `${def.cmd} ${args}` : def.cmd;
          const synthMessages = [{
            role: "user",
            content: [{ type: "text", text: promptText }],
            timestamp: Date.now(),
          }];
          try {
            const prepareResult = await vcPost(
              baseUrl,
              "/api/v1/context/prepare",
              vcKey,
              identity.convId,
              { messages: synthMessages },
              60000,
              debug ? log : null
            );
            if (prepareResult?.vc_command) {
              return { text: renderVcCommandMessage(prepareResult) };
            }
            return { text: `[VC ${def.cmd}] no command response from cloud (raw: ${JSON.stringify(prepareResult).slice(0, 200)})` };
          } catch (err) {
            log.error?.(`[vc] /${def.name} command failed: ${err}`);
            return { text: `Error running /${def.name}: ${err.message}` };
          }
        },
      });
    }

    // /vcreingest — local-only (no cloud call); mirrors the prompt-text intercept handler.
    api.registerCommand({
      name: "vcreingest",
      description: "Reset VC ingest tracker; the next message will re-send full history.",
      acceptsArgs: false,
      handler: async (ctx) => {
        const sessionId = ctx?.sessionId ?? ctx?.sessionKey ?? "unknown";
        resetSessionIngest(sessionId);
        log.info?.(`[vc] /vcreingest — reset ingest tracker for session=${sessionId}`);
        return { text: `Session ${sessionId} marked for re-ingest. The full conversation history will be sent to Virtual Context on the next message.` };
      },
    });

    log.info?.(`[vc] registered ${vcSlashCommands.length + 1} native slash commands (vcstatus, vcmerge, vclabel, vcattach, vcreingest)`);
    }

    // ── before_prompt_build: prepare context ──
    // FILESYSTEM: Reads sessions.json to resolve the current model (read-only).
    // NETWORK: POST /api/v1/context/prepare — sends full message history to cloud.
    // PAYLOAD: Replaces messages in-place with the compressed payload from the cloud.
    // ── before_agent_reply: claim VC commands before the agent harness runs ──
    // For VCSTATUS / VCMERGE / VCLABEL / VCATTACH / VCREINGEST typed as plain text,
    // claim the reply directly here. The gateway's before_agent_reply pipeline accepts
    // {handled: true, reply: {text}} and short-circuits the LLM round-trip, so the
    // response bypasses Bast's message-tool-only delivery harness entirely. Without
    // this, the legacy `before_prompt_build` prependContext path emits the response
    // into the LLM assistant.content, which the agent harness then drops in
    // messageToolOnly mode (group/channel chats by default), and the user sees
    // nothing.
    api.on("before_agent_reply", async (event, ctx) => {
      const promptText = (event?.cleanedBody ?? "").trim();
      // DIAG: log every invocation so we know who's calling
      log.info?.(`[vc:DIAG-bar] entry trigger=${ctx?.trigger ?? "?"} sessionKey=${ctx?.sessionKey ?? "?"} sessionId=${ctx?.sessionId ?? "?"} channel=${ctx?.channel ?? ctx?.messageProvider ?? "?"} channelId=${ctx?.channelId ?? "?"} promptHead=${JSON.stringify(promptText.slice(0,60))}`);
      if (!/^VC[A-Z]/i.test(promptText)) {
        log.info?.(`[vc:DIAG-bar] not a VC command, falling through`);
        return;
      }
      const sessionId = ctx?.sessionId ?? ctx?.sessionKey ?? "unknown";
      const identity = selectConvId(ctx?.sessionKey ?? "", sessionId);
      log.info?.(`[vc:DIAG-bar] matched VC command, will call cloud sessionId=${sessionId} conv=${identity.convId}`);

      // VCREINGEST is local-only — no cloud round-trip
      if (/^VCREINGEST\b/i.test(promptText)) {
        resetSessionIngest(sessionId);
        vcCommandSessions.add(sessionId);
        log.info?.(`[vc] before_agent_reply: VCREINGEST — reset ingest tracker for session=${sessionId}`);
        return {
          handled: true,
          reply: (await loadSuppressionMarker(log))({ text: `Session ${sessionId} marked for re-ingest. The full conversation history will be sent to Virtual Context on the next message.` }),
        };
      }

      // Cloud-handled commands: synthesize a minimal prepare request with the VC prompt
      const synthMessages = [{
        role: "user",
        content: [{ type: "text", text: promptText }],
        timestamp: Date.now(),
      }];
      try {
        const prepareResult = await vcPost(
          baseUrl,
          "/api/v1/context/prepare",
          vcKey,
          identity.convId,
          { messages: synthMessages },
          60000,
          debug ? log : null
        );
        if (prepareResult?.vc_command) {
          vcCommandSessions.add(sessionId);
          const replyText = renderVcCommandMessage(prepareResult);
          log.info?.(`[vc:DIAG-bar] returning handled reply: vc_command=${prepareResult.vc_command} replyTextHead=${JSON.stringify(replyText.slice(0,80))}`);
          log.info?.(`[vc] before_agent_reply: VC command ${prepareResult.vc_command} — handled directly (skipping LLM)`);
          return { handled: true, reply: (await loadSuppressionMarker(log))({ text: replyText }) };
        }
        // Cloud didn't recognize it as a VC command — let the normal flow run
        log.warn?.(`[vc] before_agent_reply: prompt looked like VC command but cloud did not respond with vc_command (got keys: ${Object.keys(prepareResult || {}).join(",")})`);
        return;
      } catch (err) {
        log.error?.(`[vc] before_agent_reply: VC command failed: ${err}`);
        return { handled: true, reply: (await loadSuppressionMarker(log))({ text: `Error running VC command: ${err.message}` }) };
      }
    });

    api.on("before_prompt_build", async (event, ctx) => {
      const sessionId = ctx?.sessionId ?? "unknown";
      const sessionKey = ctx?.sessionKey ?? "";
      const promptText = (event.prompt ?? "").trim();

      // This must run before VC prepare and on EVERY prompt-build pass. The
      // Codex Discord harness rebuilds the prompt after the first hook result;
      // if only the first pass is guarded, the second pass replaces it with VC
      // context and the bare @Vast mention becomes authoritative again.
      const replyOnlyDirective = resolveReplyOnlyDirective(
        event.prompt,
        sessionId,
      );
      if (replyOnlyDirective) {
        // Enrichment is skipped for this turn, but the turn still has to be
        // recorded. Prepare never runs on this path, so unless the user half
        // is captured here the completed-turn ingest arrives unpaired and the
        // whole turn — the answer included — is discarded as a fragment.
        // Only the earliest prompt-build pass carries the untouched body;
        // later passes fold the host's assembled context into the prompt.
        //
        // Keyed by the host message id so a later pass of THIS message keeps the
        // earlier body, while a value left behind by a previous turn is replaced.
        // Without that distinction a stale entry — from a turn that exited early
        // via a VC command, the provider filter, or an empty answer — would be
        // sent as this turn's user half.
        const replyOnlyId = parseConversationInfo(event.prompt)?.message_id ?? "";
        if (!pendingUserTurn.has(sessionId) || pendingUserTurnMessage.get(sessionId) !== replyOnlyId) {
          const replyOnlyBody = currentTurnForIngest(event.prompt) || (event.prompt ?? "");
          if (replyOnlyBody) {
            pendingUserTurn.set(sessionId, replyOnlyBody);
            pendingUserTurnMessage.set(sessionId, replyOnlyId);
          }
        }
        log.warn?.(
          `[vc] reply-only invocation — enforcing replied-to request on this ` +
          `prompt-build pass (VC enrichment skipped). session=${sessionId}`
        );
        return { prependContext: replyOnlyDirective };
      }

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
          const { transition, lastPassed } = noteFilterResult(filterPassState, sessionKey, currentModel, false);
          if (transition) {
            (log.warn ?? log.info)?.(
              `[vc] WARN provider filter now SKIPPING session=${sessionId} (${currentModel}) — ` +
              `was passing as ${lastPassed}. VC prepare/ingest are OFF for this session until ` +
              `its model returns to the allowlist (check model fallback / provider auth).`
            );
          } else {
            log.info?.(`[vc] skipping — ${currentModel} not in provider filter`);
          }
          return;
        }
        if (currentModel) {
          noteFilterResult(filterPassState, sessionKey, currentModel, true);
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
      //
      // Derived once here and reused for every append below, so the payload,
      // the speaker labels, and the user half carried to agent_end all describe
      // the same text. Deriving it twice would let those disagree and hash the
      // same logical turn two different ways.
      // Falls back to the raw prompt when nothing survives derivation, e.g. a
      // turn whose entire text is host scaffolding. Appending nothing would
      // leave the completed-turn ingest unpaired and discard the whole turn as
      // a fragment. A row that still carries scaffolding can be repaired later;
      // a turn that was never recorded cannot.
      const currentBody = currentTurnForIngest(event.prompt) || (event.prompt ?? "");
      let messagesWithCurrentTurn = [...event.messages];
      if (currentBody) {
        messagesWithCurrentTurn.push({
          role: "user",
          content: [{ type: "text", text: currentBody }],
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
          if (currentBody) {
            messagesWithCurrentTurn.push({
              role: "user",
              content: [{ type: "text", text: currentBody }],
            });
          }
          isInitialIngest = true;
        } else {
          // JSONL not available or smaller than windowed — mark as ingested anyway
          markSessionIngested(sessionId, messagesWithCurrentTurn.length);
          log.info?.(`[vc] no JSONL advantage — marked session=${sessionId} as ingested (${messagesWithCurrentTurn.length} messages)`);
        }
      }

      // Stamp who said what, before the payload leaves. This is applied to the
      // messages the cloud stores AND to the ones that come back as the model's
      // prompt, so the two never disagree about a message's text.
      const speakerNames = readSpeakerNames(sessionKey, sessionId, log);
      messagesWithCurrentTurn = labelSpeakers(
        messagesWithCurrentTurn, speakerNames, log,
      );

      // Carry this turn's user text to agent_end so the pair can be rebuilt if
      // the cloud loses the half it recorded here.
      for (let i = messagesWithCurrentTurn.length - 1; i >= 0; i--) {
        const m = messagesWithCurrentTurn[i];
        if (m?.role !== "user") continue;
        const text = speakerMessageText(m.content);
        if (text) {
          pendingUserTurn.set(sessionId, text);
          pendingUserTurnMessage.set(sessionId, parseConversationInfo(event.prompt)?.message_id ?? "");
        }
        break;
      }

      const prepareBody = {
        messages: messagesWithCurrentTurn,
        model: ctx?.model ?? undefined,
      };
      // Conversation identity: stable scopes get the sk: id; the predecessor
      // forward-link hint goes on prepare ONLY, and only when the selected
      // identity is stable (it then necessarily differs from the session UUID).
      const identity = selectConvId(sessionKey, sessionId);
      const predecessor = identity.isStable && identity.convId !== sessionId ? sessionId : undefined;

      if (debug) {
        log.info?.(`[vc:debug] prepare request — url=${baseUrl}/api/v1/context/prepare vcconv=${identity.convId}${predecessor ? ` predecessor=${predecessor}` : ""} messages=${prepareBody.messages?.length ?? 0} model=${prepareBody.model ?? "?"}`);
        log.info?.(`[vc:debug] prepare first message: ${JSON.stringify(prepareBody.messages?.[0])?.slice(0, 300)}`);
        log.info?.(`[vc:debug] prepare last message: ${JSON.stringify(prepareBody.messages?.[prepareBody.messages.length - 1])?.slice(0, 300)}`);
      }

      let prepareResult;
      try {
        const prepareTimeoutMs = selectPrepareTimeout({ isVcCommand, isInitialIngest });
        prepareResult = await vcPost(baseUrl, "/api/v1/context/prepare", vcKey, identity.convId, prepareBody, prepareTimeoutMs, log, predecessor ? { predecessor } : {});
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
        // Render cloud's command response via the message/error/bracket fallback chain.
        const cmdMessage = renderVcCommandMessage(prepareResult);
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

      // Defensive fail-open: on any reply turn, if VC's prepared body is
      // malformed (no usable messages), do not push it over the host's native
      // reply-bearing prompt. Losing enrichment beats losing the request.
      if (preparedBodyUnusableForReply(event.prompt, body)) {
        log.warn?.(
          `[vc] reply turn with malformed prepared body — leaving the native ` +
          `turn unchanged. session=${sessionId}`
        );
        return;
      }

      // Hoist any leading role:"system" entry in body.messages into body.system,
      // so the existing systemPrompt-override path below routes it to the model.
      const hoistedChars = hoistSystemPreamble(body);
      if (hoistedChars) {
        log.info?.(`[vc] hoisted ${hoistedChars}-char system preamble from body.messages[0] into body.system`);
      }

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

      const identity = selectConvId(sessionKey, sessionId);
      log.info?.(`[vc] ingest — session=${sessionId} conv=${identity.convId} assistant_message=${assistantMessage.length} chars`);
      if (debug) log.info?.(`[vc:debug] ingest request — assistant_message preview: ${assistantMessage.slice(0, 300)}`);

      const userMessage = pendingUserTurn.get(sessionId);
      pendingUserTurn.delete(sessionId);
      pendingUserTurnMessage.delete(sessionId);

      try {
        const ingestResult = await vcPost(baseUrl, "/api/v1/context/ingest", vcKey, identity.convId, {
          assistant_message: assistantMessage,
          // Repairs the pair when the cloud lost the user half it recorded at
          // prepare; ignored when it still has it.
          ...(userMessage ? { user_message: userMessage } : {}),
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
