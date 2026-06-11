/**
 * Stable conversation-identity derivation + predecessor URL transport.
 *
 * deriveConvIdentity(sessionKey, sessionId) -> { convId, isStable, fallbackReason? }
 *
 * Stable scopes get `sk:` + sessionKey (cron run-suffix stripped); subagent and
 * explicit sessions are intentionally ephemeral (no warning reason beyond their
 * scope name); missing/unparseable keys fall back to the session UUID with a
 * reason the caller counts and warns on.
 *
 * buildUrl gains an options object: { predecessor } appends an encoded
 * `predecessor` param after `vcconv`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveConvIdentity, buildUrl, vcPost } from "../index.js";

const SID = "11111111-2222-4333-8444-555555555555";

describe("deriveConvIdentity — stable scopes", () => {
  const stable = [
    "agent:bastkid-dedicated:telegram:direct:8049932331",
    "agent:bastkid-dedicated:telegram:group:-5156869263",
    "agent:bastkid-dedicated:telegram:slash:8049932331",
    "agent:bastkid-dedicated:discord:channel:1485708353660260422",
    "agent:bastkid-dedicated:main",
    "agent:bastkid-dedicated:cron:a3fd1191-ecfc-45fe-8764-3ec4b5ea0287",
  ];
  for (const key of stable) {
    it(`stable: ${key}`, () => {
      const r = deriveConvIdentity(key, SID);
      expect(r).toEqual({ convId: `sk:${key}`, isStable: true });
    });
  }

  it("cron run-suffix is stripped to the per-job identity", () => {
    const r = deriveConvIdentity(
      "agent:bastkid-dedicated:cron:a3fd1191-ecfc-45fe-8764-3ec4b5ea0287:run:4bba53b6-b095-440a-a0e4-1eaf53d2e31a",
      SID
    );
    expect(r).toEqual({
      convId: "sk:agent:bastkid-dedicated:cron:a3fd1191-ecfc-45fe-8764-3ec4b5ea0287",
      isStable: true,
    });
  });

  it("two agents sharing a peer id get distinct conv ids", () => {
    const a = deriveConvIdentity("agent:alpha:telegram:direct:42", SID);
    const b = deriveConvIdentity("agent:beta:telegram:direct:42", SID);
    expect(a.convId).not.toBe(b.convId);
  });
});

describe("deriveConvIdentity — intentional ephemeral (no warning class)", () => {
  it("subagent spawns stay per-session", () => {
    const r = deriveConvIdentity("agent:bastkid-dedicated:subagent:32049344-3585-41b4-8f41-6b522b5c6b9d", SID);
    expect(r).toEqual({ convId: SID, isStable: false, fallbackReason: "subagent" });
  });

  it("explicit (disposable/probe) sessions stay per-session", () => {
    const r = deriveConvIdentity(`agent:bastkid-dedicated:explicit:${SID}`, SID);
    expect(r).toEqual({ convId: SID, isStable: false, fallbackReason: "explicit" });
  });
});

describe("deriveConvIdentity — fallbacks that must be warned on", () => {
  it("missing sessionKey", () => {
    expect(deriveConvIdentity("", SID)).toEqual({
      convId: SID, isStable: false, fallbackReason: "missing_session_key",
    });
    expect(deriveConvIdentity(undefined, SID)).toEqual({
      convId: SID, isStable: false, fallbackReason: "missing_session_key",
    });
  });

  it("unknown scope shapes are NOT wildcarded into stable ids", () => {
    const r = deriveConvIdentity("agent:bastkid-dedicated:matrix:room:!abc", SID);
    expect(r).toEqual({ convId: SID, isStable: false, fallbackReason: "unparseable_session_key" });
  });

  it("case variants of structural tokens are unparseable, not best-effort", () => {
    const r = deriveConvIdentity("Agent:bastkid-dedicated:telegram:direct:42", SID);
    expect(r).toEqual({ convId: SID, isStable: false, fallbackReason: "unparseable_session_key" });
  });

  it("truncated scopes are unparseable", () => {
    expect(deriveConvIdentity("agent:bastkid-dedicated:telegram:direct", SID).fallbackReason)
      .toBe("unparseable_session_key");
    expect(deriveConvIdentity("agent:bastkid-dedicated", SID).fallbackReason)
      .toBe("unparseable_session_key");
    expect(deriveConvIdentity("agent::main", SID).fallbackReason)
      .toBe("unparseable_session_key");
  });
});

describe("buildUrl predecessor option", () => {
  it("appends encoded predecessor after vcconv", () => {
    const url = buildUrl("https://api.example.com", "/api/v1/context/prepare", "k",
      "sk:agent:a:telegram:direct:42", { predecessor: SID });
    expect(url).toBe(
      `https://api.example.com/api/v1/context/prepare?vckey=k&vcconv=sk%3Aagent%3Aa%3Atelegram%3Adirect%3A42&predecessor=${SID}`
    );
  });

  it("omits predecessor when not provided", () => {
    const url = buildUrl("https://api.example.com", "/x", "k", "conv-1");
    expect(url).toBe("https://api.example.com/x?vckey=k&vcconv=conv-1");
    const url2 = buildUrl("https://api.example.com", "/x", "k", "conv-1", {});
    expect(url2).toBe("https://api.example.com/x?vckey=k&vcconv=conv-1");
  });

  it("percent-encodes a predecessor that needs it", () => {
    const url = buildUrl("https://api.example.com", "/x", "k", "c", { predecessor: "a:b" });
    expect(url).toContain("predecessor=a%3Ab");
  });
});

describe("vcPost forwards predecessor to the wire", () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  it("includes predecessor in the request URL when passed", async () => {
    await vcPost("https://api.example.com", "/api/v1/context/prepare", "k", "sk:agent:a:main",
      { messages: [] }, 15000, null, { predecessor: SID });
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain("vcconv=sk%3Aagent%3Aa%3Amain");
    expect(calledUrl).toContain(`predecessor=${SID}`);
  });

  it("no predecessor param without the option (byte-identical legacy URL)", async () => {
    await vcPost("https://api.example.com", "/api/v1/context/ingest", "k", "conv-1",
      { assistant_message: "x" }, 15000, null);
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toBe("https://api.example.com/api/v1/context/ingest?vckey=k&vcconv=conv-1");
  });
});
