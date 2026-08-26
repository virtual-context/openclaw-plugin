/**
 * Post-compaction survivor suppression.
 *
 * After the runtime compacts a session, the next prompt's event.messages
 * carries the post-compaction SURVIVORS and summary: the runtime's compressed
 * view of the conversation, not conversation history. Forwarding that to VC
 * as history presents a multi-turn payload the service has never seen in that
 * shape, and the service already holds every turn it ingested.
 *
 * The plugin is the registered context engine, so the gateway calls ITS
 * compact() to perform compaction. That is the in-band signal: compact()
 * reports a completed compaction through onCompaction, notePostCompaction
 * flags the session, and the next prepare consumes the flag and sends only
 * the current turn. One flag, one suppression: later prepares carry whatever
 * the window holds, and a compaction that did not happen flags nothing.
 */
import { describe, it, expect, vi } from "vitest";
import {
  notePostCompaction,
  consumePostCompactionSuppression,
} from "../index.js";
import { createSpeakerAttributedContextEngine } from "../attributed-context-engine.js";

const SESSION = "d63512bb-6ff7-4d3a-9c60-0f9e6a3f2c11";

describe("notePostCompaction / consumePostCompactionSuppression", () => {
  it("suppresses exactly once per flag", () => {
    const state = new Set();
    expect(notePostCompaction(state, SESSION)).toBe(true);
    expect(consumePostCompactionSuppression(state, SESSION)).toBe(true);
    expect(consumePostCompactionSuppression(state, SESSION)).toBe(false);
  });

  it("never suppresses a session that was not flagged", () => {
    expect(consumePostCompactionSuppression(new Set(), SESSION)).toBe(false);
  });

  it("collapses repeated compactions before a prepare into one suppression", () => {
    const state = new Set();
    notePostCompaction(state, SESSION);
    notePostCompaction(state, SESSION);
    expect(consumePostCompactionSuppression(state, SESSION)).toBe(true);
    expect(consumePostCompactionSuppression(state, SESSION)).toBe(false);
  });

  it("flags sessions independently", () => {
    const state = new Set();
    notePostCompaction(state, SESSION);
    expect(consumePostCompactionSuppression(state, "other-session")).toBe(false);
    expect(consumePostCompactionSuppression(state, SESSION)).toBe(true);
  });

  it("refuses to flag an unusable key", () => {
    const state = new Set();
    for (const key of ["", "   ", null, undefined, 42]) {
      expect(notePostCompaction(state, key)).toBe(false);
    }
    expect(state.size).toBe(0);
  });
});

describe("context engine compact() compaction notice", () => {
  const PARAMS = { sessionId: SESSION, sessionKey: `agent:coach:main:${SESSION}` };

  function engineWith({ result, onCompaction }) {
    return createSpeakerAttributedContextEngine({
      delegateCompactionToRuntime: vi.fn(async () => result),
      onCompaction,
      log: null,
    });
  }

  it("notices a completed compaction with the gateway's params", async () => {
    const onCompaction = vi.fn();
    const result = { ok: true, compacted: true, result: { summary: "s" } };
    const engine = engineWith({ result, onCompaction });

    await expect(engine.compact(PARAMS)).resolves.toBe(result);
    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(onCompaction).toHaveBeenCalledWith(PARAMS, result);
  });

  it("stays quiet when the runtime did not compact", async () => {
    // Same success predicate the runtime itself uses (ok && compacted): a
    // refused or no-op compaction leaves the window meaning what it meant.
    const onCompaction = vi.fn();
    for (const result of [
      { ok: true, compacted: false },
      { ok: false, compacted: false, reason: "nope" },
      { ok: false, compacted: true },
      undefined,
    ]) {
      const engine = engineWith({ result, onCompaction });
      await expect(engine.compact(PARAMS)).resolves.toBe(result);
    }
    expect(onCompaction).not.toHaveBeenCalled();
  });

  it("a throwing notice never breaks compaction", async () => {
    const result = { ok: true, compacted: true };
    const engine = engineWith({
      result,
      onCompaction: () => {
        throw new Error("boom");
      },
    });
    await expect(engine.compact(PARAMS)).resolves.toBe(result);
  });

  it("works without an onCompaction dependency", async () => {
    const result = { ok: true, compacted: true };
    const engine = engineWith({ result, onCompaction: undefined });
    await expect(engine.compact(PARAMS)).resolves.toBe(result);
  });
});
