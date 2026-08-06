import { describe, expect, it } from "vitest";
import {
  buildReplyOnlyDirective,
  clearReplyOnlyDirectiveCache,
  currentMessageBody,
  hasReplyContext,
  isReplyOnlyInvocation,
  replyTargetBody,
  resolveReplyOnlyDirective,
} from "../index.js";

function replyPrompt({ body = "What reddits is the thots job pulling from", typed = "<@1485681229608259666>" } = {}) {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      message_id: "1527739552456773642",
      reply_to_id: "1527739528876654792",
      has_reply_context: true,
    }, null, 2),
    "```",
    "",
    "Reply target of current user message (untrusted, for context):",
    "```json",
    JSON.stringify({ sender_label: "kidw.ai", body }, null, 2),
    "```",
    "",
    typed,
  ].join("\n");
}

describe("reply-only Discord invocation", () => {
  it("extracts the replied-to request and removes metadata from the typed body", () => {
    const prompt = replyPrompt();
    expect(hasReplyContext(prompt)).toBe(true);
    expect(currentMessageBody(prompt)).toBe("<@1485681229608259666>");
    expect(replyTargetBody(prompt)).toBe("What reddits is the thots job pulling from");
    expect(isReplyOnlyInvocation(prompt)).toBe(true);
  });

  it("recognizes Discord's managed Vast role as a bare invocation", () => {
    const prompt = replyPrompt({ typed: "<@&1524968904340930633>" });
    expect(isReplyOnlyInvocation(prompt)).toBe(true);
    expect(buildReplyOnlyDirective(prompt)).toContain(
      "Treat the replied-to message below as the current user request",
    );
  });

  it("builds an explicit instruction to answer the replied-to message", () => {
    const directive = buildReplyOnlyDirective(replyPrompt());
    expect(directive).toContain("Treat the replied-to message below as the current user request");
    expect(directive).toContain(JSON.stringify("What reddits is the thots job pulling from"));
    expect(directive).toContain("Do not greet the user");
  });

  it("uses a verified target body instead of stale host metadata", () => {
    const directive = buildReplyOnlyDirective(replyPrompt({
      body: "stale untrusted question",
    }), {
      targetBody: "verified Discord question",
    });
    expect(directive).toContain("verified Discord question");
    expect(directive).not.toContain("stale untrusted question");
  });

  it("does not activate when the reply contains its own question", () => {
    const prompt = replyPrompt({ typed: "<@1485681229608259666> Which subreddits does it use?" });
    expect(isReplyOnlyInvocation(prompt)).toBe(false);
    expect(buildReplyOnlyDirective(prompt)).toBe("");
  });

  it("fails open when the host marks a reply but omits its target body", () => {
    const prompt = replyPrompt({ body: "   " });
    expect(isReplyOnlyInvocation(prompt)).toBe(true);
    expect(replyTargetBody(prompt)).toBe("");
    expect(buildReplyOnlyDirective(prompt)).toBe("");
  });

  it("reuses the directive on the Codex harness's second prompt-build pass", () => {
    clearReplyOnlyDirectiveCache();
    const firstPass = replyPrompt();
    const firstDirective = resolveReplyOnlyDirective(firstPass, "session-1", 1000);
    expect(firstDirective).toContain("What reddits is the thots job pulling from");

    // The first hook result is now present, so this is no longer syntactically
    // a bare-mention prompt. The message id is unchanged, however, because it
    // is the same Discord event being compiled a second time.
    const secondPass = `${firstPass}\n\nOpenClaw assembled context for this turn:\n${firstDirective}`;
    expect(isReplyOnlyInvocation(secondPass)).toBe(false);
    expect(resolveReplyOnlyDirective(secondPass, "session-1", 2000)).toBe(firstDirective);
  });

  it("does not reuse a cached directive for the next Discord message", () => {
    clearReplyOnlyDirectiveCache();
    resolveReplyOnlyDirective(replyPrompt(), "session-1", 1000);
    const nextMessage = replyPrompt({ typed: "<@1485681229608259666> New question" })
      .replace("1527739552456773642", "different-message-id");
    expect(resolveReplyOnlyDirective(nextMessage, "session-1", 2000)).toBe("");
  });
});
