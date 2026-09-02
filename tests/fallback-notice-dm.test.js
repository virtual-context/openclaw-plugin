/**
 * Model-fallback notice rerouting: operator DM instead of channel noise.
 *
 * The gateway posts transition notices ("↪️ Model Fallback: ..." and
 * "↪️ Model Fallback cleared: ...") into the reply stream with no config
 * toggle. The operator wants to SEE them without members seeing plumbing.
 * The message_sending hook fires pre-delivery on every outbound payload and
 * may modify or cancel it (the host's documented contract) — so the plugin
 * cancels the channel delivery and DMs the configured operator instead.
 *
 * Fail-safe rule: the notice is only cancelled when the DM leg is actually
 * dispatchable (operator configured AND a bot token available). Losing the
 * notice entirely is worse than posting it in-channel.
 */
import { describe, it, expect } from "vitest";
import {
  isModelFallbackNotice,
  routeFallbackNotice,
} from "../index.js";

const NOTICE = "↪️ Model Fallback: minimax/MiniMax-M2.7 (selected openai/gpt-5.6-sol; overloaded)";
const CLEARED = "↪️ Model Fallback cleared: openai/gpt-5.6-sol (was minimax/MiniMax-M2.7)";
const USER = "387316537012518913";

describe("isModelFallbackNotice", () => {
  it("matches both notice forms, tolerating leading whitespace", () => {
    expect(isModelFallbackNotice(NOTICE)).toBe(true);
    expect(isModelFallbackNotice(CLEARED)).toBe(true);
    expect(isModelFallbackNotice("  " + NOTICE)).toBe(true);
  });

  it("does not match ordinary replies or mid-string mentions", () => {
    for (const text of [
      "The model fallback behavior is configured in openclaw.json",
      "I saw a ↪️ Model Fallback notice earlier — here is what it means:",
      "",
      undefined,
      null,
    ]) {
      expect(isModelFallbackNotice(text)).toBe(false);
    }
  });
});

describe("routeFallbackNotice", () => {
  it("cancels the channel delivery and DMs when fully dispatchable", () => {
    const d = routeFallbackNotice({
      content: NOTICE,
      operatorUserId: USER,
      token: "bot-token",
    });
    expect(d).toEqual({ cancel: true, dm: true });
  });

  it("passes through untouched when the content is not a notice", () => {
    expect(
      routeFallbackNotice({
        content: "regular reply",
        operatorUserId: USER,
        token: "bot-token",
      }),
    ).toBe(null);
  });

  it("passes through when no operator is configured (feature off)", () => {
    expect(
      routeFallbackNotice({ content: NOTICE, operatorUserId: "", token: "t" }),
    ).toBe(null);
  });

  it("fails safe: no token means the notice stays in-channel, never lost", () => {
    const d = routeFallbackNotice({
      content: NOTICE,
      operatorUserId: USER,
      token: "",
    });
    expect(d).toEqual({ cancel: false, dm: false, reason: "no-token" });
  });

  it("rejects a malformed operator id rather than DMing garbage", () => {
    expect(
      routeFallbackNotice({
        content: NOTICE,
        operatorUserId: "optics#123",
        token: "t",
      }),
    ).toBe(null);
  });
});
