/**
 * Unresolved-model accounting for the provider filter.
 *
 * `resolveSessionModel` returns null when OpenClaw's session store has no
 * usable entry for a session key. The filter reads `currentModel && !has(...)`,
 * so a null model has always bypassed the allowlist entirely. That bypass is
 * correct only while the unknown is TRANSIENT (a new session that has not
 * reached the store yet); a permanently unresolvable model turns the bypass
 * into an indefinite silent exemption.
 *
 * `noteUnresolvedModel(state, sessionKey, resolved)` bounds it:
 *
 * - resolved            : clears the entry, re-arming the full window
 * - unresolved, n <= 3  : bypass=true  (the original race accommodation)
 * - unresolved, n == 4  : bypass=false, refusalOnset=true  (report once)
 * - unresolved, n > 4   : bypass=false, refusalOnset=false (stay quiet)
 *
 * `unresolvedModelBypassAllowed` is the read-only view the ingest hook uses so
 * both halves of one turn reach the same verdict.
 */
import { describe, it, expect } from "vitest";
import {
  noteUnresolvedModel,
  unresolvedModelBypassAllowed,
} from "../index.js";

const KEY = "agent:gymbrobot-intake:extract:d63512bb";
const GRACE = 3;

describe("noteUnresolvedModel", () => {
  it("bypasses inside the grace window, counting up", () => {
    const state = new Map();
    for (let turn = 1; turn <= GRACE; turn++) {
      const r = noteUnresolvedModel(state, KEY, false);
      expect(r.consecutive).toBe(turn);
      expect(r.bypass).toBe(true);
      expect(r.refusalOnset).toBe(false);
    }
  });

  it("refuses once the window closes, and announces it exactly once", () => {
    const state = new Map();
    for (let turn = 1; turn <= GRACE; turn++) {
      noteUnresolvedModel(state, KEY, false);
    }

    const onset = noteUnresolvedModel(state, KEY, false);
    expect(onset.consecutive).toBe(GRACE + 1);
    expect(onset.bypass).toBe(false);
    expect(onset.refusalOnset).toBe(true);

    // Every later turn still refuses, but must not re-announce: a line per
    // turn forever is the noise that gets a real signal filtered out.
    for (let extra = 0; extra < 5; extra++) {
      const later = noteUnresolvedModel(state, KEY, false);
      expect(later.bypass).toBe(false);
      expect(later.refusalOnset).toBe(false);
    }
  });

  it("a resolved model clears the count and re-arms the full window", () => {
    const state = new Map();
    noteUnresolvedModel(state, KEY, false);
    noteUnresolvedModel(state, KEY, false);

    const recovered = noteUnresolvedModel(state, KEY, true);
    expect(recovered.consecutive).toBe(0);
    expect(recovered.bypass).toBe(false);
    expect(state.has(KEY)).toBe(false);

    // Re-armed, not resumed: an intermittent store read must not accumulate
    // toward a refusal across unrelated turns.
    const after = noteUnresolvedModel(state, KEY, false);
    expect(after.consecutive).toBe(1);
    expect(after.bypass).toBe(true);
  });

  it("counts each session independently", () => {
    const state = new Map();
    const other = "agent:gymbrobot:web:direct:u1:conv:c1";
    for (let turn = 0; turn <= GRACE; turn++) {
      noteUnresolvedModel(state, KEY, false);
    }
    expect(noteUnresolvedModel(state, KEY, false).bypass).toBe(false);
    expect(noteUnresolvedModel(state, other, false).bypass).toBe(true);
  });
});

describe("unresolvedModelBypassAllowed", () => {
  it("agrees with the prepare-side verdict without advancing it", () => {
    const state = new Map();
    for (let turn = 1; turn <= GRACE; turn++) {
      const prepared = noteUnresolvedModel(state, KEY, false);
      // The ingest half of the SAME turn must reach the same answer, and must
      // leave the counter where prepare left it.
      expect(unresolvedModelBypassAllowed(state, KEY)).toBe(prepared.bypass);
      expect(state.get(KEY)).toBe(turn);
    }

    const refused = noteUnresolvedModel(state, KEY, false);
    expect(refused.bypass).toBe(false);
    expect(unresolvedModelBypassAllowed(state, KEY)).toBe(false);
    expect(state.get(KEY)).toBe(GRACE + 1);
  });

  it("allows a session it has never seen", () => {
    // An ingest with no preceding prepare must behave exactly as before this
    // accounting existed, rather than refusing on absent state.
    expect(unresolvedModelBypassAllowed(new Map(), "never-seen")).toBe(true);
  });

  it("repeated reads never advance the counter", () => {
    const state = new Map();
    noteUnresolvedModel(state, KEY, false);
    for (let read = 0; read < 10; read++) {
      expect(unresolvedModelBypassAllowed(state, KEY)).toBe(true);
    }
    expect(state.get(KEY)).toBe(1);
  });
});
