/**
 * OT4.3 — vitest unit: defensive `message ?? error ?? bracket` fallback chain on
 * vc_command error envelopes.
 *
 * Pins plan §6.2 OT4.3 + spec §12.9 (error response shape contract: cloud should
 * populate BOTH `error` AND `message` for user-recoverable errors). The plugin's
 * 5.0.1 fix (`6be933e`) added the `error` fallback so that any cloud envelope
 * shape that omits `message` still renders informative text rather than the
 * meaningless `[VC <command>]` placeholder.
 *
 * Three envelope shapes covered:
 *   1. Both `message` AND `error` populated — primary `message` wins.
 *   2. Only `error` populated, `message` undefined — falls back to `error`.
 *   3. Both `message` AND `error` absent — falls through to `[VC <command>]` placeholder.
 *
 * Plus edge cases for nullish-vs-empty-string discipline and missing vc_command.
 */
import { describe, it, expect } from "vitest";
import { renderVcCommandMessage } from "../index.js";

describe("OT4.3 — renderVcCommandMessage fallback chain", () => {
  it("(a) when message is populated, renders message verbatim (primary path)", () => {
    const envelope = {
      vc_command: "attach",
      message: "No conversation found matching 'foo'. Use a label or ID from the dashboard.",
      error: "No conversation found matching 'foo'. Use a label or ID from the dashboard.",
      conversation_id: "sess-1",
    };
    expect(renderVcCommandMessage(envelope)).toBe(
      "No conversation found matching 'foo'. Use a label or ID from the dashboard.",
    );
  });

  it("(b) when only error is populated, falls back to error (5.0.1 defensive fix)", () => {
    // Cloud's pre-`55bf234` VCATTACH error path shape: error-only, no message field.
    // 5.0.0 plugin would have rendered "[VC attach]" — the silent-swallow bug.
    // 5.0.1 plugin renders the error string instead.
    const envelope = {
      vc_command: "attach",
      error: "target_not_found",
      conversation_id: "sess-1",
    };
    expect(renderVcCommandMessage(envelope)).toBe("target_not_found");
  });

  it("(c) when both message and error are absent, falls through to [VC <cmd>] placeholder", () => {
    // The original 5.0.0 fallback. Should only fire if the cloud violates §12.9
    // (which says BOTH error and message must be populated on every error case).
    const envelope = {
      vc_command: "merge",
      conversation_id: "sess-1",
    };
    expect(renderVcCommandMessage(envelope)).toBe("[VC merge]");
  });

  it("treats empty-string message as truthy (renders empty string, not fallback)", () => {
    // ?? is nullish-coalescing — null/undefined trigger fallback, but "" does not.
    // This is intentional: if the cloud explicitly sends "", that's the cloud's
    // choice and the plugin honors it (the LLM will be told to echo nothing).
    const envelope = { vc_command: "label", message: "", error: "should-not-render" };
    expect(renderVcCommandMessage(envelope)).toBe("");
  });

  it("falls back to error when message is null (not just undefined)", () => {
    // Cloud might set message: null for "intentionally absent" — covered by ??.
    const envelope = { vc_command: "status", message: null, error: "no-active-session" };
    expect(renderVcCommandMessage(envelope)).toBe("no-active-session");
  });

  it("placeholder uses '?' when vc_command itself is missing (defensive)", () => {
    // Hardening against malformed cloud responses that lack vc_command entirely.
    const envelope = {};
    expect(renderVcCommandMessage(envelope)).toBe("[VC ?]");
  });

  it("handles a null/undefined envelope without throwing (defensive)", () => {
    // The `before_prompt_build` handler only calls renderVcCommandMessage inside
    // `if (prepareResult.vc_command)`, so this case shouldn't hit in production —
    // but defensive code is cheap.
    expect(renderVcCommandMessage(null)).toBe("[VC ?]");
    expect(renderVcCommandMessage(undefined)).toBe("[VC ?]");
  });
});

describe("OT4.3 — VCMERGE error-envelope shapes per spec §12.9", () => {
  // Spec §12.9 mandates that every vc_command:"merge" error response populates BOTH
  // `error` (programmatic code) AND `message` (human-readable). These tests pin the
  // plugin's behavior across the canonical error shapes core's spec calls out.
  const cases = [
    {
      name: "MergeBusy (transient, retry hint)",
      envelope: {
        vc_command: "merge",
        error: "MergeBusy",
        message: "Cannot merge right now — Telegram DM is currently ingesting. Try again in a moment.",
      },
      expected: "Cannot merge right now — Telegram DM is currently ingesting. Try again in a moment.",
    },
    {
      name: "SourceNotFound",
      envelope: {
        vc_command: "merge",
        error: "source_not_found",
        message: "Source conversation 'X' not found or already merged. No changes made.",
      },
      expected: "Source conversation 'X' not found or already merged. No changes made.",
    },
    {
      name: "merge_routed_outside_cloud_rest (engine-bypass refusal per v1.4-1)",
      envelope: {
        vc_command: "merge",
        error: "merge_routed_outside_cloud_rest",
        message: "Internal: VCMERGE must route through cloud's REST handler. Refusing.",
      },
      expected: "Internal: VCMERGE must route through cloud's REST handler. Refusing.",
    },
    {
      name: "Idempotent retry (success-shape per §12.7)",
      envelope: {
        vc_command: "merge",
        message: "Already merged (merge_id 7e3...) — 358 turns from Telegram DM into ChatGPT. No-op.",
        merge_summary: { idempotent_replay: true, merge_id: "7e3..." },
      },
      expected: "Already merged (merge_id 7e3...) — 358 turns from Telegram DM into ChatGPT. No-op.",
    },
  ];

  for (const { name, envelope, expected } of cases) {
    it(`renders cleanly: ${name}`, () => {
      expect(renderVcCommandMessage(envelope)).toBe(expected);
    });
  }
});
