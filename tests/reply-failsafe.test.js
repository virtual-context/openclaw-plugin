/**
 * Reply-only invocation fail-safe.
 *
 * A native Discord reply whose body is just the bot mention carries its real
 * request in the replied-to message. The host delivers this correctly, but it
 * also appends the raw current-message body as the final "Current user request"
 * line; when VC replaces the system prompt with its compressed context, that
 * trailing raw mention becomes authoritative and the replied-to question is
 * lost (proven: reply "@Vast" to a question -> "Here, Reshi. What needs
 * doing?"). VC must decline to override for that turn.
 *
 * These pin the decision that gates the override, over the exact current-turn
 * envelope the host produces (captured from the proven failure rollout).
 */
import { describe, it, expect } from "vitest";
import {
  isReplyOnlyInvocation,
  parseConversationInfo,
  currentMessageBody,
  preparedBodyUnusableForReply,
} from "../index.js";

// The current-turn envelope for the proven failure: a reply to
// "How can I allow someone else to direct message you on discord" whose body
// is only "@Vast".
const REPLY_ONLY = [
  "Conversation info (untrusted metadata):",
  "```json",
  JSON.stringify({
    chat_id: "channel:1524946242499514418",
    message_id: "1526979825103802388",
    reply_to_id: "1526979755314909247",
    sender: { id: "387316537012518913", name: "optics", username: "kidw.ai" },
    was_mentioned: true,
    has_reply_context: true,
  }, null, 2),
  "```",
  "",
  "Reply target of current user message (untrusted, for context):",
  "```json",
  JSON.stringify({
    sender_label: "kidw.ai",
    body: "How can I allow someone else to direct message you on discord",
  }, null, 2),
  "```",
  "",
  "@Vast",
].join("\n");

// A reply that ALSO types a real question — the request has its own substance.
const REPLY_WITH_QUESTION = REPLY_ONLY.replace(
  "\n@Vast", "\n@Vast what about the DM privacy setting");

// Inline: the question is typed in the body, no reply context.
const INLINE = [
  "Conversation info (untrusted metadata):",
  "```json",
  JSON.stringify({
    message_id: "1526980000000000000",
    sender: { id: "387316537012518913", name: "optics" },
    was_mentioned: true,
    has_reply_context: false,
  }, null, 2),
  "```",
  "",
  "How can I allow someone else to direct message you on discord @Vast",
].join("\n");

// Ordinary non-reply message, no envelope at all (e.g. a plain prompt).
const PLAIN = "how do I rotate the certs";

describe("parseConversationInfo", () => {
  it("reads the structured conversation-info block", () => {
    const info = parseConversationInfo(REPLY_ONLY);
    expect(info.has_reply_context).toBe(true);
    expect(info.reply_to_id).toBe("1526979755314909247");
  });
  it("returns null when there is no envelope", () => {
    expect(parseConversationInfo(PLAIN)).toBeNull();
  });
});

describe("currentMessageBody", () => {
  it("strips the labeled metadata blocks, leaving the typed body", () => {
    expect(currentMessageBody(REPLY_ONLY)).toBe("@Vast");
    expect(currentMessageBody(REPLY_WITH_QUESTION))
      .toBe("@Vast what about the DM privacy setting");
  });
  it("leaves a plain message untouched", () => {
    expect(currentMessageBody(PLAIN)).toBe(PLAIN);
  });
});

describe("isReplyOnlyInvocation — the override gate", () => {
  it("1. reply-only '@Vast' fails open (the proven failure)", () => {
    expect(isReplyOnlyInvocation(REPLY_ONLY)).toBe(true);
  });

  it("2. inline question with a mention is enriched normally", () => {
    expect(isReplyOnlyInvocation(INLINE)).toBe(false);
  });

  it("3. ordinary non-reply message is enriched normally", () => {
    expect(isReplyOnlyInvocation(PLAIN)).toBe(false);
  });

  it("4b. a reply that also types a real question is enriched normally", () => {
    // Reply context is present, but the body has its own request, so the
    // trailing raw line is not impoverished — VC enrichment is safe and useful.
    expect(isReplyOnlyInvocation(REPLY_WITH_QUESTION)).toBe(false);
  });

  it("5. malformed / empty current turn does not force a fail-open", () => {
    // No envelope => not a detectable reply => normal path (the separate
    // `if (!body) return` guards a missing prepared body).
    expect(isReplyOnlyInvocation("")).toBe(false);
    expect(isReplyOnlyInvocation(undefined)).toBe(false);
  });

  it("keys on reply_to_id even when has_reply_context is absent", () => {
    const onlyReplyId = REPLY_ONLY.replace('"has_reply_context": true', '"has_reply_context": false');
    // reply_to_id still present -> still a reply.
    expect(isReplyOnlyInvocation(onlyReplyId)).toBe(true);
  });

  it("a raw <@id> mention body also counts as bare", () => {
    const raw = REPLY_ONLY.replace("\n@Vast", "\n<@1327648199513964565>");
    expect(isReplyOnlyInvocation(raw)).toBe(true);
  });
});

describe("preparedBodyUnusableForReply — malformed-body fail-open (regression 5)", () => {
  it("fails open when a reply turn gets no usable messages", () => {
    expect(preparedBodyUnusableForReply(REPLY_WITH_QUESTION, { messages: [] })).toBe(true);
    expect(preparedBodyUnusableForReply(REPLY_WITH_QUESTION, {})).toBe(true);
    expect(preparedBodyUnusableForReply(REPLY_WITH_QUESTION, null)).toBe(true);
  });
  it("does not fire on a healthy reply body", () => {
    expect(preparedBodyUnusableForReply(REPLY_WITH_QUESTION, {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })).toBe(false);
  });
  it("does not constrain non-reply turns", () => {
    expect(preparedBodyUnusableForReply(PLAIN, { messages: [] })).toBe(false);
  });
});
