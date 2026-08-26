/**
 * Never-passing sessions under the provider filter.
 *
 * noteFilterResult can WARN on a pass-to-skip transition, but a session whose
 * model has NEVER been in the allowlist produces only the generic per-turn
 * skip line, indistinguishable from a deliberate exclusion. An operator who
 * meant to capture that agent but omitted its model (or one link of its
 * fallback chain) from `providers` gets no signal that anything is missing.
 *
 * noteNeverPassedSkip supplies it: a notice on the FIRST skipped turn of a
 * never-passed session and again every NEVER_PASSED_NOTICE_EVERY skips, each
 * naming the model, so the condition stays visible for as long as it holds.
 * One pass silences the session permanently: from then on the transition WARN
 * owns the story.
 */
import { describe, it, expect } from "vitest";
import {
  noteNeverPassedSkip,
  NEVER_PASSED_NOTICE_EVERY,
} from "../index.js";

const KEY = "agent:gymbrobot:telegram:group:g1";

describe("noteNeverPassedSkip", () => {
  it("notices the first skipped turn of a never-passed session", () => {
    const state = new Map();
    const r = noteNeverPassedSkip(state, KEY, false);
    expect(r).toEqual({ notice: true, skips: 1 });
  });

  it("stays quiet between periodic notices, then re-notices", () => {
    const state = new Map();
    for (let turn = 1; turn <= NEVER_PASSED_NOTICE_EVERY + 1; turn++) {
      const r = noteNeverPassedSkip(state, KEY, false);
      expect(r.skips).toBe(turn);
      expect(r.notice).toBe(turn === 1 || turn === NEVER_PASSED_NOTICE_EVERY);
    }
  });

  it("a single pass silences the session for good", () => {
    const state = new Map();
    noteNeverPassedSkip(state, KEY, false);
    noteNeverPassedSkip(state, KEY, true);

    // Later skips are the transition-WARN population, not this one: the
    // session HAS passed, so "never passed" would be a false claim.
    for (let turn = 0; turn < NEVER_PASSED_NOTICE_EVERY * 2; turn++) {
      expect(noteNeverPassedSkip(state, KEY, false).notice).toBe(false);
    }
  });

  it("counts each session independently", () => {
    const state = new Map();
    const other = "agent:coach:telegram:group:g2";
    noteNeverPassedSkip(state, KEY, false);
    const r = noteNeverPassedSkip(state, other, false);
    expect(r).toEqual({ notice: true, skips: 1 });
  });

  it("counts per session across model changes", () => {
    // A session bouncing between two unlisted fallback models has still never
    // passed; the state is keyed by session, so the count carries across the
    // model strings the caller reports in its log line.
    const state = new Map();
    noteNeverPassedSkip(state, KEY, false);
    const r = noteNeverPassedSkip(state, KEY, false);
    expect(r.skips).toBe(2);
  });
});
