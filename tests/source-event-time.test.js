import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSourceAttestation } from "../index.js";

const body = "Please use Navigator for the next fortnight.";
const inbound = {
  platform: "discord", agentScopeId: "agent:example", accountId: "account-test",
  messageId: "message-test", originChannelId: "channel-test", guildId: "guild-test",
  senderId: "member-test", promptRunId: "run-test",
  bodyHash: createHash("sha256").update(body).digest("hex"),
};

describe("BUG-003: exact source claims retain transport occurrence time", () => {
  it("serializes the bound message timestamp without replacing it with send time", () => {
    const sourceTimestamp = Date.parse("2026-04-03T12:04:05.678Z");
    const claim = buildSourceAttestation({ ...inbound, sourceTimestamp }, body, "", { includeOccurredAt: true });
    expect(claim.occurred_at).toBe("2026-04-03T12:04:05.678Z");
    expect(claim.canonical_body_sha256).toBe(inbound.bodyHash);
    expect(buildSourceAttestation({ ...inbound, sourceTimestamp }, body, "", { includeOccurredAt: true })).toEqual(claim);
  });

  it.each([undefined, null, NaN, Infinity, "2026-04-03", -1, 9e15])(
    "keeps a legacy claim when no usable bound occurrence time exists: %s",
    (sourceTimestamp) => {
      const claim = buildSourceAttestation({ ...inbound, sourceTimestamp }, body, "", { includeOccurredAt: true });
      expect(claim).not.toBeNull();
      expect(claim).not.toHaveProperty("occurred_at");
    },
  );

  it("does not mint a timestamp claim when source identity is missing", () => {
    expect(buildSourceAttestation({ ...inbound, messageId: "", sourceTimestamp: 12345 }, body))
      .toBeNull();
  });
});
