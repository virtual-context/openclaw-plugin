/**
 * Codex-routed agents keep one Codex thread across turns.
 *
 * Without a projection lifecycle the host projects the whole history into a
 * fresh Codex thread every turn, which rebuilds the thread each time and
 * leaves the provider no reusable prompt prefix.
 */
import { describe, it, expect, vi } from "vitest";
import { createSpeakerAttributedContextEngine } from "../attributed-context-engine.js";

const make = (extra = {}) => createSpeakerAttributedContextEngine({
  delegateCompactionToRuntime: vi.fn(),
  captureTranscriptReadAdmission: () => undefined,
  historyImageLabeler: null,
  ...extra,
});
const params = (sessionKey) => ({
  messages: [{ role: "user", content: "earlier", timestamp: 1 }, { role: "assistant", content: "ok", timestamp: 2 }],
  prompt: "now?", sessionKey, sessionId: "s1", runId: "r1",
});

describe("codex thread projection", () => {
  it("asks the host to bootstrap the thread once per epoch for a routed agent", async () => {
    const engine = make({ threadProjectionFor: (key) => (key.startsWith("agent:bast:") ? "vc-proxy-1" : null) });
    const routed = await engine.assemble(params("agent:bast:telegram:direct:1"));
    expect(routed.contextProjection).toEqual({ mode: "thread_bootstrap", epoch: "vc-proxy-1" });
    expect(routed.messages).toHaveLength(2);
    const other = await engine.assemble(params("agent:other:main"));
    expect(other.contextProjection).toBeUndefined();
  });
  it("a missing or broken callback keeps per-turn projection", async () => {
    expect((await make().assemble(params("agent:bast:main"))).contextProjection).toBeUndefined();
    const log = { info: vi.fn(), warn: vi.fn() };
    for (const bad of [() => { throw new Error("boom"); }, () => 7, () => ""]) {
      const out = await make({ threadProjectionFor: bad, log }).assemble(params("agent:bast:main"));
      expect(out.contextProjection).toBeUndefined();
    }
  });
});
