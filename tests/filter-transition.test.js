/**
 * Provider-filter transition tracking (silent-degradation warning).
 *
 * `noteFilterResult(state, sessionKey, model, passed)` records per-session
 * filter outcomes and reports a transition exactly when a session that
 * previously PASSED the filter is now being skipped:
 *
 * - pass → skip : transition=true, lastPassed = the model that used to pass
 * - skip from first sighting (never passed): transition=false
 * - repeated skips after a transition: transition=false (warn once)
 * - pass again after skip, then skip: a NEW transition fires
 */
import { describe, it, expect } from "vitest";
import { noteFilterResult } from "../index.js";

describe("noteFilterResult", () => {
  it("no transition when a session is skipped without ever passing", () => {
    const state = new Map();
    const r = noteFilterResult(state, "agent:a:telegram:direct:1", "minimax/m2.7", false);
    expect(r.transition).toBe(false);
    expect(r.lastPassed).toBe(null);
  });

  it("records passes and reports a transition on pass → skip", () => {
    const state = new Map();
    noteFilterResult(state, "k", "openai-codex/gpt-5.5", true);
    const r = noteFilterResult(state, "k", "minimax/minimax-m2.7", false);
    expect(r.transition).toBe(true);
    expect(r.lastPassed).toBe("openai-codex/gpt-5.5");
  });

  it("warns only once: repeated skips after a transition are not transitions", () => {
    const state = new Map();
    noteFilterResult(state, "k", "openai-codex/gpt-5.5", true);
    expect(noteFilterResult(state, "k", "minimax/m", false).transition).toBe(true);
    expect(noteFilterResult(state, "k", "minimax/m", false).transition).toBe(false);
    expect(noteFilterResult(state, "k", "minimax/m", false).transition).toBe(false);
  });

  it("a recovery (pass) re-arms the transition warning", () => {
    const state = new Map();
    noteFilterResult(state, "k", "openai-codex/gpt-5.5", true);
    expect(noteFilterResult(state, "k", "minimax/m", false).transition).toBe(true);
    noteFilterResult(state, "k", "openai-codex/gpt-5.5", true);
    const r = noteFilterResult(state, "k", "minimax/m", false);
    expect(r.transition).toBe(true);
    expect(r.lastPassed).toBe("openai-codex/gpt-5.5");
  });

  it("sessions are tracked independently", () => {
    const state = new Map();
    noteFilterResult(state, "a", "openai-codex/gpt-5.5", true);
    expect(noteFilterResult(state, "b", "minimax/m", false).transition).toBe(false);
    expect(noteFilterResult(state, "a", "minimax/m", false).transition).toBe(true);
  });

  it("latest passing model wins as lastPassed", () => {
    const state = new Map();
    noteFilterResult(state, "k", "openai-codex/gpt-5.4", true);
    noteFilterResult(state, "k", "openai-codex/gpt-5.5", true);
    expect(noteFilterResult(state, "k", "minimax/m", false).lastPassed).toBe("openai-codex/gpt-5.5");
  });
});
