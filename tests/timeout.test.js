/**
 * OT4.1 — vitest unit: `vcPost` timeout selection per branch.
 *
 * Pins the spec contract from plan §6.2 OT4.1:
 *   `isVcCommand ? 60000 : (isInitialIngest ? 120000 : 15000)`
 *
 * - VC commands (VCMERGE, VCATTACH, VCMERGE PREVIEW, etc.) → 60s.
 * - Initial JSONL ingest path → 120s.
 * - Everything else → 15s (preserved historical default).
 *
 * The test exercises `selectPrepareTimeout` directly (pure function) and asserts
 * `vcPost` passes the chosen timeout to fetch's AbortSignal. Together this proves
 * the call site at index.js:395 honors the per-branch contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { selectPrepareTimeout, vcPost } from "../index.js";

describe("OT4.1 — selectPrepareTimeout per-branch values", () => {
  it("VC command (commit path) returns 60000ms", () => {
    expect(selectPrepareTimeout({ isVcCommand: true, isInitialIngest: false })).toBe(60000);
  });

  it("VC command takes precedence over initial-ingest flag", () => {
    // If both flags fire (rare but possible — first prepare call on a session whose
    // user typed VCMERGE on turn 1), VC-command branch wins because the cloud-side
    // dispatch happens regardless of ingest size.
    expect(selectPrepareTimeout({ isVcCommand: true, isInitialIngest: true })).toBe(60000);
  });

  it("initial JSONL ingest (non-VC-command) returns 120000ms", () => {
    expect(selectPrepareTimeout({ isVcCommand: false, isInitialIngest: true })).toBe(120000);
  });

  it("normal prepare (neither branch) returns the 15000ms default", () => {
    expect(selectPrepareTimeout({ isVcCommand: false, isInitialIngest: false })).toBe(15000);
  });

  it("called with no args defaults to 15000ms (defensive)", () => {
    expect(selectPrepareTimeout()).toBe(15000);
    expect(selectPrepareTimeout({})).toBe(15000);
  });
});

describe("OT4.1 — vcPost honors the timeout argument via AbortSignal.timeout", () => {
  let originalFetch;
  let abortTimeoutSpy;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Spy on AbortSignal.timeout to capture the timeout values passed to it.
    abortTimeoutSpy = vi.spyOn(AbortSignal, "timeout");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    abortTimeoutSpy.mockRestore();
  });

  it("passes 60000ms to AbortSignal.timeout when isVcCommand is true", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ vc_command: "merge", message: "ok" }),
    });

    const timeoutMs = selectPrepareTimeout({ isVcCommand: true, isInitialIngest: false });
    await vcPost("https://api.virtual-context.com", "/api/v1/context/prepare", "vc-key", "session-1", { messages: [] }, timeoutMs, null);

    expect(abortTimeoutSpy).toHaveBeenCalledWith(60000);
  });

  it("passes 120000ms when isInitialIngest is true", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ body: { messages: [] } }),
    });

    const timeoutMs = selectPrepareTimeout({ isVcCommand: false, isInitialIngest: true });
    await vcPost("https://api.virtual-context.com", "/api/v1/context/prepare", "vc-key", "session-1", { messages: [] }, timeoutMs, null);

    expect(abortTimeoutSpy).toHaveBeenCalledWith(120000);
  });

  it("passes 15000ms in the default branch", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ body: { messages: [] } }),
    });

    const timeoutMs = selectPrepareTimeout({ isVcCommand: false, isInitialIngest: false });
    await vcPost("https://api.virtual-context.com", "/api/v1/context/prepare", "vc-key", "session-1", { messages: [] }, timeoutMs, null);

    expect(abortTimeoutSpy).toHaveBeenCalledWith(15000);
  });
});
