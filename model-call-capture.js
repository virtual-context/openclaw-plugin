import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const DEFAULT_MODEL_CALL_CAPTURE = Object.freeze({
  enabled: false,
  directory: join(homedir(), ".openclaw", "logs", "virtual-context", "model-calls"),
  maxBytes: 512 * 1024 * 1024,
  maxFiles: 2_000,
  maxAgeHours: 7 * 24,
});

const README_NAME = "README.txt";
const CAPTURE_SUFFIX = ".json.gz";
let captureSequence = 0;

function finiteInteger(value, fallback, minimum) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

/** Resolve and bound operator-supplied model-call capture settings. */
export function normalizeModelCallCaptureConfig(raw = {}) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const configuredDirectory = typeof value.directory === "string"
    ? value.directory.trim()
    : "";
  const directory = configuredDirectory
    ? (isAbsolute(configuredDirectory)
      ? resolve(configuredDirectory)
      : resolve(homedir(), configuredDirectory))
    : DEFAULT_MODEL_CALL_CAPTURE.directory;
  return {
    enabled: value.enabled === true,
    directory,
    maxBytes: finiteInteger(
      value.maxBytes,
      DEFAULT_MODEL_CALL_CAPTURE.maxBytes,
      1024 * 1024,
    ),
    maxFiles: finiteInteger(value.maxFiles, DEFAULT_MODEL_CALL_CAPTURE.maxFiles, 2),
    maxAgeHours: finiteInteger(
      value.maxAgeHours,
      DEFAULT_MODEL_CALL_CAPTURE.maxAgeHours,
      1,
    ),
  };
}

function safeFilePart(value, fallback = "unknown") {
  const text = typeof value === "string" ? value.trim() : "";
  const safe = text.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (safe || fallback).slice(0, 96);
}

function ensureCaptureDirectory(config) {
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  // Existing directories may have been created under a permissive umask.
  chmodSync(config.directory, 0o700);
  const readme = join(config.directory, README_NAME);
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        "Virtual Context model-call captures",
        "",
        "Each *.json.gz file contains one complete, untruncated OpenClaw hook event.",
        "Inspect with: gzip -dc <file> | jq .",
        "",
        "llm_input records every field OpenClaw exposes, including systemPrompt, prompt,",
        "historyMessages, image count, and correlation metadata.",
        "llm_output records the paired model output and usage metadata.",
        "These records intentionally contain conversation content and are mode 0600.",
        "Provider request bytes, tool definitions/images, and provider-side persistent",
        "thread state are not exposed or materialized by the llm_input hook;",
        "use runId/sessionId with the OpenClaw trajectory to correlate its threadId.",
        "Retention is enforced by total compressed bytes, file count, and age.",
        "",
      ].join("\n"),
      { encoding: "utf-8", mode: 0o600, flag: "wx" },
    );
  }
}

/** Remove expired/oldest captures until every configured bound is satisfied. */
export function pruneModelCallCaptures(config, nowMs = Date.now()) {
  if (!existsSync(config.directory)) return { removed: 0, bytes: 0, files: 0 };
  const candidates = [];
  for (const name of readdirSync(config.directory)) {
    if (!name.endsWith(CAPTURE_SUFFIX)) continue;
    const path = join(config.directory, name);
    try {
      const stat = statSync(path);
      if (stat.isFile()) candidates.push({ path, name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A concurrent cleanup may have removed it.
    }
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  const cutoff = nowMs - config.maxAgeHours * 60 * 60 * 1000;
  let totalBytes = candidates.reduce((sum, item) => sum + item.size, 0);
  let remainingFiles = candidates.length;
  let removed = 0;
  for (const item of candidates) {
    const expired = item.mtimeMs < cutoff;
    const overCount = remainingFiles > config.maxFiles;
    const overBytes = totalBytes > config.maxBytes;
    if (!expired && !overCount && !overBytes) continue;
    try {
      unlinkSync(item.path);
      totalBytes -= item.size;
      remainingFiles -= 1;
      removed += 1;
    } catch {
      // Best effort; the next capture retries retention.
    }
  }
  return { removed, bytes: totalBytes, files: remainingFiles };
}

function selectedContext(ctx = {}) {
  const sender = ctx?.channelContext?.sender;
  return {
    runId: typeof ctx.runId === "string" ? ctx.runId : null,
    sessionId: typeof ctx.sessionId === "string" ? ctx.sessionId : null,
    sessionKey: typeof ctx.sessionKey === "string" ? ctx.sessionKey : null,
    agentId: typeof ctx.agentId === "string" ? ctx.agentId : null,
    trigger: typeof ctx.trigger === "string" ? ctx.trigger : null,
    messageProvider: typeof ctx.messageProvider === "string" ? ctx.messageProvider : null,
    channelId: typeof ctx.channelId === "string" ? ctx.channelId : null,
    chatId: typeof ctx.chatId === "string" ? ctx.chatId : null,
    senderId: typeof ctx.senderId === "string"
      ? ctx.senderId
      : (typeof sender?.id === "string" ? sender.id : null),
  };
}

/**
 * Persist one exact OpenClaw LLM boundary event.
 *
 * This is the complete plugin hook payload, not a claim that a stateful
 * provider re-sent its already-cached thread on the wire for this turn.
 */
export function captureModelCallEvent(config, kind, event, ctx = {}) {
  if (!config?.enabled) return null;
  if (kind !== "llm_input" && kind !== "llm_output") {
    throw new Error(`unsupported model-call capture kind: ${kind}`);
  }
  ensureCaptureDirectory(config);
  const capturedAt = new Date().toISOString();
  const payload = event && typeof event === "object" ? event : {};
  const payloadJson = JSON.stringify(payload);
  const record = {
    schema: "virtual-context.openclaw-model-call.v2",
    capturedAt,
    captureSurface: kind,
    limitation: (
      "complete OpenClaw hook event; provider request bytes, tool definitions/images, " +
      "and provider-side persistent thread state are not exposed by this hook"
    ),
    correlation: selectedContext(ctx),
    event: {
      runId: typeof event?.runId === "string" ? event.runId : null,
      sessionId: typeof event?.sessionId === "string" ? event.sessionId : null,
      provider: typeof event?.provider === "string" ? event.provider : null,
      model: typeof event?.model === "string" ? event.model : null,
    },
    payloadSha256: createHash("sha256").update(payloadJson, "utf-8").digest("hex"),
    payload,
  };
  const raw = Buffer.from(JSON.stringify(record), "utf-8");
  const compressed = gzipSync(raw, { level: 6 });
  const stamp = capturedAt.replace(/[-:.TZ]/g, "");
  captureSequence = (captureSequence + 1) % 1_000_000;
  const sequence = String(captureSequence).padStart(6, "0");
  const runId = safeFilePart(event?.runId || ctx?.runId, "no-run");
  const sessionId = safeFilePart(event?.sessionId || ctx?.sessionId, "no-session");
  const base = `${stamp}_${sequence}_${process.pid}_${runId}_${sessionId}_${kind}`;
  const finalPath = join(config.directory, `${base}_${randomUUID()}${CAPTURE_SUFFIX}`);
  const temporaryPath = `${finalPath}.tmp`;
  try {
    writeFileSync(temporaryPath, compressed, { mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, finalPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* nothing to clean */ }
    throw error;
  }
  const retention = pruneModelCallCaptures(config);
  return {
    path: finalPath,
    compressedBytes: compressed.length,
    uncompressedBytes: raw.length,
    retention,
  };
}
