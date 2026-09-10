import { describe, expect, it } from "vitest";
import { buildVerifiedReplyProvenance } from "../index.js";

const target = () => ({
  messageId: "target", actorId: "actor:test:assistant", senderName: "Assistant",
  body: "I have not found the puzzle result.",
  parent: { messageId: "parent", actorId: "actor:test:participant", senderName: "Participant",
    body: "You acknowledged my puzzle win." },
});

describe("verified reply participant provenance", () => {
  it("carries the parent separately without substituting the direct subject", () => {
    const result = buildVerifiedReplyProvenance(target());
    expect(result.reply_subject_actor_id).toBe("actor:test:assistant");
    expect(result.reply_target_parent).toEqual({
      message_id: "parent", actor_id: "actor:test:participant", name: "Participant",
      body: "You acknowledged my puzzle win.",
    });
    expect(result).not.toHaveProperty("sender_actor_id");
  });

  it.each(["unavailable", "no-body", "no-actor", "self-link"])("omits a %s parent", (kind) => {
    const value = target();
    if (kind === "unavailable") value.parent.status = "unavailable";
    if (kind === "no-body") value.parent.body = "";
    if (kind === "no-actor") value.parent.actorId = "";
    if (kind === "self-link") value.parent.messageId = value.messageId;
    const result = buildVerifiedReplyProvenance(value);
    expect(result.reply_target_message_id).toBe("target");
    expect(result).not.toHaveProperty("reply_target_parent");
  });
});
