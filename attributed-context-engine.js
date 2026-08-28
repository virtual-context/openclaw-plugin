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

function trustedSpeaker(message, platform) {
  if (message?.role !== "user" || !platform) return null;
  const sourceChannel = typeof message.sourceChannel === "string"
    ? message.sourceChannel.trim().toLowerCase()
    : "";
  const senderId = typeof message.senderId === "string"
    ? message.senderId.trim()
    : "";
  const name = typeof message.senderName === "string"
    ? message.senderName.trim()
    : "";
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
    senderId: typeof trailing.senderId === "string"
      ? trailing.senderId.trim()
      : "",
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

/** A legacy-parity context engine with speaker-aware group projection. */
export function createSpeakerAttributedContextEngine({
  delegateCompactionToRuntime,
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
      version: "5.5.0",
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(params) {
      let currentPrompt = params.prompt;
      try {
        if (typeof normalizeCurrentPrompt === "function") {
          currentPrompt = normalizeCurrentPrompt(params.prompt);
        }
        const currentSpeaker = trustedCurrentGroupSpeaker(
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
      const messages = attributeGroupHistoryMessages(
        params.messages,
        params.sessionKey,
        currentPrompt,
        log,
      );
      const systemPromptAddition = typeof buildMemorySystemPromptAddition === "function"
        ? buildMemorySystemPromptAddition({
            availableTools: params.availableTools,
            citationsMode: params.citationsMode,
          })
        : undefined;
      return {
        messages,
        estimatedTokens: 0,
        ...(systemPromptAddition ? { systemPromptAddition } : {}),
      };
    },
    async afterTurn() {},
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
