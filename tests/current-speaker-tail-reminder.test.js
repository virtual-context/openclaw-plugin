/**
 * Current-speaker guard placement.
 *
 * Multi-party defect shape (Discord guild turn, gpt-5.6-sol): the
 * <current-speaker> boundary was installed at the HEAD of the prepared
 * system text and rendered verbatim with the right speaker, but hundreds of
 * history rows attributed to ANOTHER member sat between it and the
 * host-appended "Current user request:" frame at the tail. The model
 * attributed the current request to the dominant history speaker anyway.
 *
 * Fix under test: the composition keeps the head boundary (it anchors the
 * actor-card that follows it) AND appends a compact speaker restatement as
 * the LAST element of the system text, so after buildCodexPreparedContext
 * wraps it, only the closing wrapper tag stands between the restatement and
 * the host-appended current request. The host's byte-dedup of the trailing
 * user row is untouched: nothing here edits message rows.
 */
import { describe, it, expect } from "vitest";
import {
  buildCurrentSpeakerBoundary,
  buildCurrentSpeakerTailReminder,
  composeAttributedSystemText,
  buildCodexPreparedContext,
} from "../index.js";

// The real turn's speaker (actor id from the gateway log line).
const OPTICS = { actorId: "actor:discord:387316537012518913", name: "optics" };

// Stand-in for the ~445 history rows of the real turn, all attributed to the
// OTHER member: dense wrong-speaker context between guard and request.
const HISTORY_WALL = Array.from({ length: 40 }, (_, i) =>
  `<message-speaker source="host-session-metadata">{"name":"BigTex"}</message-speaker>\nBigTex message ${i}`,
).join("\n");

describe("buildCurrentSpeakerTailReminder", () => {
  it("returns empty without a trusted actor id, like the head boundary", () => {
    for (const speaker of [null, undefined, {}, { name: "optics" }]) {
      expect(buildCurrentSpeakerTailReminder(speaker)).toBe("");
    }
  });

  it("restates the speaker identity with attribution-only authority", () => {
    const reminder = buildCurrentSpeakerTailReminder(OPTICS);
    expect(reminder).toContain('authority="attribution-only"');
    expect(reminder).toContain(OPTICS.actorId);
    expect(reminder).toContain("optics");
  });
});

describe("composeAttributedSystemText", () => {
  const boundary = buildCurrentSpeakerBoundary(OPTICS);
  const reminder = buildCurrentSpeakerTailReminder(OPTICS);

  it("keeps the boundary at the head and lands the reminder last", () => {
    const composed = composeAttributedSystemText({
      systemText: HISTORY_WALL,
      attributionBoundary: boundary,
      tailReminder: reminder,
    });
    expect(composed.startsWith(boundary)).toBe(true);
    expect(composed.endsWith(reminder)).toBe(true);
    // The reminder must sit AFTER every history row, not merely appear.
    expect(composed.lastIndexOf("BigTex message")).toBeLessThan(
      composed.lastIndexOf(reminder),
    );
  });

  it("degrades to the plain system text when there is no boundary", () => {
    expect(composeAttributedSystemText({
      systemText: HISTORY_WALL,
      attributionBoundary: "",
      tailReminder: "",
    })).toBe(HISTORY_WALL);
  });

  it("carries a boundary even when the cloud supplied no system text", () => {
    const composed = composeAttributedSystemText({
      systemText: "",
      attributionBoundary: boundary,
      tailReminder: reminder,
    });
    expect(composed.startsWith(boundary)).toBe(true);
    expect(composed.endsWith(reminder)).toBe(true);
  });

  it("keeps the reminder adjacent to the host frame through the codex wrapper", () => {
    // In the codex lane the composed text becomes prependContext and the HOST
    // appends "Current user request: ..." after it. Adjacency therefore means:
    // nothing after the reminder inside the prepared text except the closing
    // wrapper tag.
    const composed = composeAttributedSystemText({
      systemText: HISTORY_WALL,
      attributionBoundary: boundary,
      tailReminder: reminder,
    });
    const prepared = buildCodexPreparedContext(composed);
    const tail = prepared.text.slice(prepared.text.lastIndexOf(reminder));
    expect(tail).toBe(`${reminder}\n</vc-prepared-context>`);
  });
});
