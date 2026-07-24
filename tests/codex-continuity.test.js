import { describe, expect, it } from "vitest";
import {
  applyCodexContinuityProjection,
  buildCodexPreparedContext,
  continuityMessageHash,
} from "../index.js";

function fixture() {
  const prior = [
    {
      role: "user",
      content:
        "@Vast Keep replies concise and begin with “ChannelBridge:”.",
    },
    {
      role: "assistant",
      content: "ChannelBridge: Understood.",
    },
  ];
  const active = {
    role: "user",
    content: [{ type: "text", text: "@Vast What is the capital of Portugal?" }],
  };
  return {
    prior,
    active,
    body: {
      system: "<system-reminder>VC actor cards and summaries</system-reminder>",
      messages: [...prior, active],
    },
    metadata: {
      recent_conversation_native: {
        message_count: prior.length,
        message_hashes: prior.map((message) =>
          continuityMessageHash(message.role, message.content)),
      },
    },
  };
}

describe("native Codex per-turn continuity", () => {
  it("projects hash-attested shared history into the per-turn prompt lane", () => {
    const { body, metadata, active } = fixture();

    const projection = applyCodexContinuityProjection(
      body,
      metadata,
      "codex",
      "run-cold",
    );

    expect(projection).toMatchObject({
      applied: true,
      messageCount: 2,
      correlationId: "run-cold",
    });
    expect(body.messages).toEqual([active]);
    expect(body.system).toContain("<vc-conversation-continuity");
    expect(body.system).toContain("ChannelBridge:");
    expect(body.system).toContain("same-requester-shared-conversation");

    const delivery = buildCodexPreparedContext(body.system);
    expect(delivery.text).toContain("<vc-prepared-context");
    expect(delivery.text).toContain(
      `fingerprint="${projection.fingerprint}"`,
    );
    expect(delivery.text).toContain("ChannelBridge:");
    expect(delivery.text).toContain("user-level authority only");
  });

  it("fails closed without mutating the prepared body when a hash is wrong", () => {
    const { body, metadata } = fixture();
    const original = structuredClone(body);
    metadata.recent_conversation_native.message_hashes[0] = "0".repeat(64);

    expect(
      applyCodexContinuityProjection(body, metadata, "codex", "run-bad"),
    ).toEqual({ applied: false, reason: "message_hash_mismatch" });
    expect(body).toEqual(original);
  });

  it("does not move dynamic context into the per-turn lane for other runtimes", () => {
    const { body, metadata } = fixture();
    const original = structuredClone(body);

    expect(
      applyCodexContinuityProjection(body, metadata, "anthropic", "run-other"),
    ).toEqual({ applied: false, reason: "runtime_not_codex" });
    expect(body).toEqual(original);
  });
});
