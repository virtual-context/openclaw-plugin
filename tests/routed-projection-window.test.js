/** Routed agents project only a recent tail of history; VC owns the rest. */
import { describe, it, expect, vi } from "vitest";
import { createSpeakerAttributedContextEngine } from "../attributed-context-engine.js";

const msg = (i, role) => ({ role, content: `${role} ${i}`, timestamp: 1_700_000_000_000 + i });
const history = (n) => Array.from({ length: n }, (_, i) => msg(i, i % 2 ? "assistant" : "user"));
const make = (extra = {}) => createSpeakerAttributedContextEngine({
  delegateCompactionToRuntime: vi.fn(),
  captureTranscriptReadAdmission: () => undefined,
  historyImageLabeler: null,
  ...extra,
});
const params = (messages) => ({ messages, prompt: "now?", sessionKey: "agent:vast:discord:guild:1", sessionId: "s1", runId: "r1" });

describe("routed projection window", () => {
  it("keeps the last N messages for a routed agent and logs once per assembly", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const engine = make({ historyWindowFor: () => 24, log });
    const out = await engine.assemble(params(history(200)));
    expect(out.messages).toHaveLength(24);
    const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    expect(text(out.messages[0])).toContain("user 176");  // attribution wraps the text; the window picks the tail
    expect(text(out.messages.at(-1))).toContain("assistant 199");
    expect(log.info.mock.calls.some(([line]) => /projection windowed — session=s1 200 -> 24/.test(line))).toBe(true);
  });
  it("leaves shorter histories and non-routed agents untouched", async () => {
    const engine = make({ historyWindowFor: (key) => (key.startsWith("agent:vast:") ? 24 : 0) });
    expect((await engine.assemble(params(history(10)))).messages).toHaveLength(10);
    const native = await engine.assemble({ ...params(history(200)), sessionKey: "agent:bastkid-dedicated:main" });
    expect(native.messages).toHaveLength(200);
    const none = make();
    expect((await none.assemble(params(history(60)))).messages).toHaveLength(60);
  });
});
