const ATTRIBUTED_MESSAGE = Symbol("virtual-context-speaker-attributed");

export const SPEAKER_ATTRIBUTED_CONTEXT_ENGINE_ID = "virtual-context";

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function groupPlatform(sessionKey) {
  if (typeof sessionKey !== "string") return "";
  const match = /^(?:sk:)?agent:[^:]+:([^:]+):(?:channel|group|guild):/.exec(
    sessionKey,
  );
  const platform = (match?.[1] ?? "").trim().toLowerCase();
  return /^[a-z0-9._-]+$/.test(platform) ? platform : "";
}

/** Read identity only from host-owned message metadata, across native formats. */
export function readHostMessageSpeaker(message) {
  if (message?.role !== "user") return null;
  const metadata = message.__openclaw;
  if (metadata != null && (typeof metadata !== "object" || Array.isArray(metadata))) {
    return null;
  }
  const transport = metadata?.transport;
  if (transport != null && (typeof transport !== "object" || Array.isArray(transport))) {
    return null;
  }
  const clean = (value, limit, lower = false) => {
    if (value == null) return "";
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (text.length > limit || /[\x00-\x1f\x7f]/.test(text)) return null;
    return lower ? text.toLowerCase() : text;
  };
  const senderIds = [message.senderId, metadata?.senderId].map((value) => clean(value, 256));
  const names = [message.senderName, metadata?.senderName].map((value) => clean(value, 128));
  const channels = [message.sourceChannel, metadata?.sourceChannel, transport?.channel]
    .map((value) => clean(value, 64, true));
  if ([...senderIds, ...names, ...channels].some((value) => value === null)) return null;
  if (new Set(senderIds.filter(Boolean)).size > 1 || new Set(channels.filter(Boolean)).size > 1) {
    return null;
  }
  // Names can change while the immutable sender id stays the same.
  return {
    senderId: senderIds.find(Boolean) ?? "",
    senderName: names[1] || names[0],
    sourceChannel: channels.find(Boolean) ?? "",
  };
}

function trustedSpeaker(message, platform) {
  if (message?.role !== "user" || !platform) return null;
  const metadata = readHostMessageSpeaker(message);
  const sourceChannel = metadata?.sourceChannel ?? "";
  const senderId = metadata?.senderId ?? "";
  const name = metadata?.senderName ?? "";
  if (
    sourceChannel !== platform
    || !senderId
    || senderId.length > 256
    || /[\x00-\x1f\x7f]/.test(senderId)
    || !name
    || name.length > 128
    || /[\x00-\x1f\x7f]/.test(name)
  ) {
    return null;
  }
  return {
    name,
    actor_id: `actor:${platform}:${senderId}`,
  };
}

/** Trusted identity for the exact trailing current group turn, if available. */
export function trustedCurrentGroupSpeaker(messages, sessionKey, prompt) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const platform = groupPlatform(sessionKey);
  const currentPrompt = typeof prompt === "string" ? prompt.trim() : "";
  const trailing = messages.at(-1);
  if (
    !platform
    || !currentPrompt
    || trailing?.role !== "user"
    || textContent(trailing.content).trim() !== currentPrompt
  ) return null;
  const speaker = trustedSpeaker(trailing, platform);
  if (!speaker) return null;
  return {
    name: speaker.name,
    actorId: speaker.actor_id,
    senderId: readHostMessageSpeaker(trailing)?.senderId ?? "",
    platform,
  };
}

function safeSpeakerJson(speaker) {
  return JSON.stringify(speaker).replace(/[<>&]/g, (character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
  })[character]);
}

/**
 * Neutralize host-attribution tag lookalikes in member-authored text.
 *
 * Applied at RENDER time only, on surfaces whose bytes are not locked: the
 * in-memory history projection here and the prepared system text in the main
 * module. Never applied before storage - stored conversation content keeps
 * its exact source bytes. The tag set covers every block the host or this
 * plugin emits with attribution or framing authority; a member typing any of
 * them gets inert escaped text, so a parseable host block can only originate
 * from the host. Idempotent: the escaped form no longer matches.
 *
 * TAG-SET SYNC: the canonical list is the Virtual Context engine's
 * HOST_ATTRIBUTION_TAGS (core/render_escape.py) - the engine owns content
 * semantics. Add new tags THERE first; this regex mirrors it. The engine
 * also emits a serialized-JSON escape form (doubled backslash) for tool
 * results; layering this escape over either engine form is a no-op.
 */
export function escapeHostAttributionMarkup(text) {
  return text.replace(
    /<\/?(?:message-speaker|current-speaker-reminder|current-speaker|current-reply-target|vc-prepared-context)\b/gi,
    (match) => `\\u003c${match.slice(1)}`,
  );
}

function containsToolProtocolPart(content) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => [
    "tool_result",
    "toolResult",
    "tool_use",
    "toolUse",
    "tool_call",
    "toolCall",
  ].includes(part?.type));
}

function withSpeakerAttribution(message, speaker, isAttributed) {
  if (message?.[ATTRIBUTED_MESSAGE]) return message;
  // Context-engine inputs normally use role=toolResult for tool output. If a
  // provider-shaped role=user tool block reaches us, preserve it byte-for-byte:
  // some provider protocols require tool-result blocks to remain first.
  if (containsToolProtocolPart(message?.content)) return message;
  const label = [
    isAttributed
      ? '<message-speaker source="host-session-metadata" authority="attribution-only">'
      : '<message-speaker source="legacy-missing-metadata" authority="unattributed">',
    safeSpeakerJson(speaker),
    "</message-speaker>",
  ].join("\n");
  let projectedMessage;
  if (typeof message.content === "string") {
    projectedMessage = {
      ...message,
      content: `${label}\n${escapeHostAttributionMarkup(message.content)}`,
    };
  } else if (Array.isArray(message.content)) {
    const content = message.content.map((part) =>
      part?.type === "text" && typeof part.text === "string"
        ? { ...part, text: escapeHostAttributionMarkup(part.text) }
        : part
    );
    const textIndex = content.findIndex(
      (part) => part?.type === "text" && typeof part.text === "string",
    );
    if (textIndex < 0) content.unshift({ type: "text", text: label });
    else {
      content[textIndex] = {
        ...content[textIndex],
        text: `${label}\n${content[textIndex].text}`,
      };
    }
    projectedMessage = { ...message, content };
  } else {
    return message;
  }
  Object.defineProperty(projectedMessage, ATTRIBUTED_MESSAGE, { value: true });
  return projectedMessage;
}

/**
 * Add trusted speaker identity to the in-memory history projection only.
 *
 * OpenClaw removes the current request from projected history after the
 * context engine returns by comparing the exact trailing user text with
 * `params.prompt`. Keep that one row byte-identical so the host's deduper
 * continues to work. Every earlier group-chat user row is labeled from
 * OpenClaw-owned sender metadata; missing or inconsistent metadata is never
 * guessed from prose.
 */
export function attributeGroupHistoryMessages(messages, sessionKey, prompt, log) {
  if (!Array.isArray(messages)) return [];
  const platform = groupPlatform(sessionKey);
  if (!platform) return messages;
  const currentPrompt = typeof prompt === "string" ? prompt.trim() : "";
  const trailingIndex = messages.length - 1;
  const trailing = messages[trailingIndex];
  const preserveTrailingCurrent = Boolean(
    currentPrompt
    && trailing?.role === "user"
    && textContent(trailing.content).trim() === currentPrompt,
  );

  let attributedCount = 0;
  let unattributedCount = 0;
  const output = messages.map((message, index) => {
    if (preserveTrailingCurrent && index === trailingIndex) return message;
    if (message?.role !== "user") return message;
    const speaker = trustedSpeaker(message, platform);
    const projected = withSpeakerAttribution(
      message,
      speaker ?? { name: null, actor_id: null },
      Boolean(speaker),
    );
    if (projected !== message) {
      if (speaker) attributedCount += 1;
      else unattributedCount += 1;
    }
    return projected;
  });
  if (attributedCount > 0 || unattributedCount > 0) {
    log?.info?.(
      `[vc:identity] attributed ${attributedCount} native group-history ` +
      `user message(s), marked ${unattributedCount} legacy row(s) unattributed ` +
      `platform=${platform}`,
    );
  }
  return attributedCount > 0 || unattributedCount > 0 ? output : messages;
}

// Current hosts fence transcript SDK reads with an async-local admission. Read
// that same host-owned receipt instead of guessing from message text or version.
const TRANSCRIPT_ADMISSION_RUNTIME = "openclaw/plugin-sdk/codex-session-transcript-runtime";
let transcriptAdmissionRuntime;
async function captureHostTranscriptReadAdmission(target) {
  transcriptAdmissionRuntime ??= import(/* @vite-ignore */ TRANSCRIPT_ADMISSION_RUNTIME)
    .catch((error) => {
      // Older hosts do not expose this contract; keep their existing projection.
      if (
        ["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND"].includes(error?.code)
        && String(error?.message).includes("codex-session-transcript-runtime")
      ) return null;
      throw error;
    });
  const runtime = await transcriptAdmissionRuntime;
  if (!runtime) return undefined;
  if (typeof runtime.captureCodexSessionTranscriptReadAdmission !== "function") {
    throw new Error("OpenClaw transcript admission reader is unavailable");
  }
  return runtime.captureCodexSessionTranscriptReadAdmission(target);
}

async function hasCurrentTurnTranscriptFence(params, capture) {
  // Embedded hosts expose the same admission but omit runtimeContext. Its lookup
  // needs only the host-owned agent/session identity, never message content.
  const agentId = typeof params.sessionKey === "string"
    ? /^(?:sk:)?agent:([^:]+):/.exec(params.sessionKey)?.[1]
    : undefined;
  const target = params.runtimeContext?.sessionTarget ?? (
    agentId && typeof params.sessionId === "string" && params.sessionId
      ? { agentId, sessionId: params.sessionId, sessionKey: params.sessionKey }
      : undefined
  );
  if (!target) return false;
  if (
    !target.agentId
    || target.sessionId !== params.sessionId
    || (params.sessionKey && target.sessionKey !== params.sessionKey)
  ) throw new Error("Transcript admission target does not match context assembly");
  const admission = await capture(target);
  if (!admission) return false;
  if (
    admission.role !== "user"
    || admission.agentId !== target.agentId
    || admission.sessionId !== target.sessionId
    || admission.sessionKey !== target.sessionKey
  ) throw new Error("Transcript admission belongs to a different assembly target");
  return true;
}


// The Codex app-server host renders assembled history into ONE prompt string
// and appends every history image it can load as a flat image list after that
// string (images: [...contextImages, ...currentTurnImages]). Text and images
// lose their pairing there: a turn with one new screenshot arrives with every
// earlier screenshot in the conversation and no way to tell which is which.
// Embedded hosts keep images structurally inside their message and prune them
// themselves, so this projection only touches the flat-rendering host.
const FLAT_IMAGE_PROJECTION_HOST_IDS = new Set(["codex-app-server"]);
const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|bmp|heic|heif|tiff?|avif)(?:[?#].*)?$/iu;
const ATTACHED_IMAGES_ARE_CURRENT_NOTE =
  "Attached images belong only to the current user request. Earlier images "
  + "are noted in the conversation text and are not attached; ask for a "
  + "re-share before describing one.";

/** True when the host flattens assembled history into a single prompt string. */
export function hostFlattensHistoryImages(runtimeSettings) {
  const id = runtimeSettings?.executionHost?.id;
  return typeof id === "string" && FLAT_IMAGE_PROJECTION_HOST_IDS.has(id.trim().toLowerCase());
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isImageMediaFact(fact) {
  if (!isRecord(fact)) return false;
  const kind = typeof fact.kind === "string" ? fact.kind.trim().toLowerCase() : "";
  if (kind) return kind === "image";
  const contentType = typeof fact.contentType === "string"
    ? fact.contentType.trim().toLowerCase()
    : "";
  if (contentType) return contentType.startsWith("image/");
  const ref = (typeof fact.path === "string" && fact.path)
    || (typeof fact.url === "string" && fact.url)
    || "";
  return IMAGE_EXTENSION_RE.test(ref);
}

function cleanNoteText(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\x00-\x1f\x7f]/gu, " ").replace(/[[\]]/gu, "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** User-facing attachment name: the host's fileName, else the staged basename. */
function attachmentDisplayName(fact) {
  const fileName = cleanNoteText(fact.fileName, 80);
  if (fileName) return fileName;
  const ref = (typeof fact.path === "string" && fact.path)
    || (typeof fact.url === "string" && fact.url)
    || "";
  const base = ref.split(/[\\/]/u).pop() ?? "";
  // Host staging names look like input-IMG_0978---<uuid>.png.
  const derived = base
    .replace(/^input-/u, "")
    .replace(/---[0-9a-f-]{8,}(?=\.[^.]+$)/iu, "");
  return cleanNoteText(derived, 80) || "image";
}

function earlierImageNote(names, speakerName) {
  const who = speakerName ? ` from ${speakerName}` : "";
  const noun = names.length === 1 ? "image" : `${names.length} images`;
  const list = names.map((name) => `"${name}"`).join(", ");
  return `[earlier ${noun}${who}: ${list}; not attached to this request]`;
}

/**
 * Detach a history message's images for a flat-rendering host.
 *
 * Returns the same object when there is nothing to detach. Otherwise returns
 * a projected copy: image facts leave `__openclaw.media` (non-image facts
 * stay), inline image parts leave the content, the host's own
 * `mediaImagePruned` flag is set so its media loader skips the row, and one
 * bracketed note names what was there so the model still knows an image was
 * shared without being handed the bytes. Never mutates the host's row.
 */
export function detachHistoryImagesForFlatProjection(message) {
  if (message?.role !== "user") return { message, detached: 0 };
  if (containsToolProtocolPart(message.content)) return { message, detached: 0 };
  const metadata = isRecord(message.__openclaw) ? message.__openclaw : null;
  const facts = Array.isArray(metadata?.media) ? metadata.media : [];
  const imageFacts = facts.filter(isImageMediaFact);
  const otherFacts = facts.filter((fact) => !imageFacts.includes(fact));
  const legacyFacts = Array.isArray(message.media) ? message.media : [];
  const legacyImageFacts = legacyFacts.filter(isImageMediaFact);
  const inlineImages = Array.isArray(message.content)
    ? message.content.filter((part) => part?.type === "image")
    : [];
  const detached = imageFacts.length + legacyImageFacts.length + inlineImages.length;
  if (detached === 0) return { message, detached: 0 };

  const names = [...imageFacts, ...legacyImageFacts].map(attachmentDisplayName);
  for (let index = 0; index < inlineImages.length; index += 1) names.push("inline image");
  const speakerName = cleanNoteText(readHostMessageSpeaker(message)?.senderName, 64);
  const note = earlierImageNote(names, speakerName);

  let content;
  if (typeof message.content === "string") {
    content = message.content.trim() ? `${message.content}\n${note}` : note;
  } else if (Array.isArray(message.content)) {
    content = [
      ...message.content.filter((part) => part?.type !== "image"),
      { type: "text", text: note },
    ];
  } else {
    content = note;
  }

  const projected = { ...message, content };
  if (legacyFacts.length) {
    const remaining = legacyFacts.filter((fact) => !legacyImageFacts.includes(fact));
    if (remaining.length) projected.media = remaining;
    else delete projected.media;
  }
  const nextMetadata = { ...(metadata ?? {}) };
  if (otherFacts.length) nextMetadata.media = otherFacts;
  else delete nextMetadata.media;
  delete nextMetadata.mediaImageLayout;
  delete nextMetadata.mediaImageBlockFactIndexes;
  nextMetadata.mediaImagePruned = true;
  projected.__openclaw = nextMetadata;
  return { message: projected, detached };
}

/**
 * Detach every history image when the host renders history flat.
 *
 * The trailing row is left untouched when it is the current request (no
 * transcript fence): the host removes it from projected history by exact
 * text, and its images travel with the turn itself, not with history.
 */
export function detachHistoryImagesForHost(messages, runtimeSettings, prompt, log) {
  if (!Array.isArray(messages) || !hostFlattensHistoryImages(runtimeSettings)) {
    return { messages, detachedImages: 0, detachedMessages: 0 };
  }
  const currentPrompt = typeof prompt === "string" ? prompt.trim() : "";
  const trailingIndex = messages.length - 1;
  const trailing = messages[trailingIndex];
  const preserveTrailingCurrent = Boolean(
    currentPrompt
    && trailing?.role === "user"
    && textContent(trailing.content).trim() === currentPrompt,
  );
  let detachedImages = 0;
  let detachedMessages = 0;
  const output = messages.map((message, index) => {
    if (preserveTrailingCurrent && index === trailingIndex) return message;
    const result = detachHistoryImagesForFlatProjection(message);
    if (result.detached > 0) {
      detachedImages += result.detached;
      detachedMessages += 1;
    }
    return result.message;
  });
  if (detachedImages > 0) {
    log?.info?.(
      `[vc:media] flat-projection host=${runtimeSettings.executionHost.id}: detached `
      + `${detachedImages} earlier image(s) from ${detachedMessages} history message(s); `
      + "only the current request's attachments travel with this turn",
    );
    return { messages: output, detachedImages, detachedMessages };
  }
  return { messages, detachedImages: 0, detachedMessages: 0 };
}

/** A stateless context engine with speaker-aware, host-fenced history projection. */
export function createSpeakerAttributedContextEngine({
  delegateCompactionToRuntime,
  captureTranscriptReadAdmission = captureHostTranscriptReadAdmission,
  buildMemorySystemPromptAddition,
  normalizeCurrentPrompt,
  onCurrentSpeaker,
  onCompaction,
  log,
}) {
  if (typeof delegateCompactionToRuntime !== "function") {
    throw new TypeError("delegateCompactionToRuntime is required");
  }
  return {
    info: {
      id: SPEAKER_ATTRIBUTED_CONTEXT_ENGINE_ID,
      name: "Virtual Context Speaker-Attributed Legacy Engine",
      version: "5.11.6",
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1",
        turnAdvancementIdempotency: "atomic-idempotent-v1",
      },
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(params) {
      // The host supplies messages strictly before the admitted current entry.
      // This engine reads no other transcript or cached history. An older row
      // repeating the current words must stay historical, never prove its author.
      const fenced = await hasCurrentTurnTranscriptFence(
        params, captureTranscriptReadAdmission,
      );
      let currentPrompt = params.prompt;
      try {
        if (typeof normalizeCurrentPrompt === "function") {
          currentPrompt = normalizeCurrentPrompt(params.prompt);
        }
        const currentSpeaker = fenced ? null : trustedCurrentGroupSpeaker(
          params.messages,
          params.sessionKey,
          currentPrompt,
        );
        onCurrentSpeaker?.({
          sessionId: params.sessionId,
          runId: params.runId,
          sessionKey: params.sessionKey,
          prompt: currentPrompt,
          speaker: currentSpeaker,
        });
      } catch (error) {
        log?.warn?.(`[vc:identity] current speaker handoff failed: ${error}`);
      }
      const attributed = attributeGroupHistoryMessages(
        params.messages,
        params.sessionKey,
        fenced ? undefined : currentPrompt,
        log,
      );
      const media = detachHistoryImagesForHost(
        attributed,
        params.runtimeSettings,
        fenced ? undefined : currentPrompt,
        log,
      );
      const messages = media.messages;
      const memoryAddition = typeof buildMemorySystemPromptAddition === "function"
        ? buildMemorySystemPromptAddition({
            availableTools: params.availableTools,
            citationsMode: params.citationsMode,
          })
        : undefined;
      const systemPromptAddition = [
        memoryAddition,
        media.detachedImages > 0 ? ATTACHED_IMAGES_ARE_CURRENT_NOTE : undefined,
      ].filter(Boolean).join("\n\n");
      return {
        messages,
        estimatedTokens: 0,
        ...(systemPromptAddition ? { systemPromptAddition } : {}),
      };
    },
    async afterTurn() {},
    async commitTurn() {
      // There is no engine-owned turn store to advance: assemble projects the
      // runtime's committed transcript, while cloud ingestion remains owned by
      // the existing plugin hooks. Replaying this no-op is atomic/idempotent
      // across process restarts and must not duplicate ingestion or compaction.
      return { status: "committed" };
    },
    async compact(params) {
      const result = await delegateCompactionToRuntime(params);
      // Report only a compaction that actually happened, under the runtime's
      // own success predicate (ok && compacted): a refused or no-op
      // compaction leaves the next prompt's history meaning what it meant.
      // The notice must never break compaction itself.
      if (result?.ok && result?.compacted) {
        try {
          onCompaction?.(params, result);
        } catch (error) {
          log?.warn?.(`[vc] post-compaction notice failed: ${error}`);
        }
      }
      return result;
    },
    async dispose() {},
  };
}

export function registerSpeakerAttributedContextEngine(api, dependencies) {
  if (typeof api?.registerContextEngine !== "function") {
    api?.logger?.warn?.(
      "[vc:identity] OpenClaw does not expose registerContextEngine; " +
      "native history speaker attribution is unavailable",
    );
    return false;
  }
  api.registerContextEngine(
    SPEAKER_ATTRIBUTED_CONTEXT_ENGINE_ID,
    () => createSpeakerAttributedContextEngine({
      ...dependencies,
      log: dependencies?.log ?? api.logger,
    }),
  );
  api?.logger?.info?.(
    `[vc:identity] registered context engine=${SPEAKER_ATTRIBUTED_CONTEXT_ENGINE_ID}`,
  );
  return true;
}
