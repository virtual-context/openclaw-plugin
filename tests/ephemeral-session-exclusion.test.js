/**
 * Cron runs, subagent spawns and OpenClaw's internal sessions never use VC.
 *
 * They are disposable work rather than conversations to remember, so
 * sessionExclusionReason keeps them out of prepare, ingest, typed VC commands
 * and proxy routing, the same four points excludeAgents guards.
 */
import { describe, it, expect } from "vitest";
import {
  buildExcludedAgentSet,
  ephemeralSessionScope,
  sessionExclusionReason,
} from "../index.js";

const NONE = buildExcludedAgentSet(undefined).excluded;

describe("ephemeralSessionScope", () => {
  it("recognizes cron sessions, with and without a run suffix", () => {
    expect(ephemeralSessionScope("agent:vast:cron:daily-digest")).toBe("cron");
    expect(ephemeralSessionScope("agent:vast:cron:daily-digest:run:7f3a")).toBe("cron");
  });

  it("recognizes subagent sessions", () => {
    expect(ephemeralSessionScope("agent:vast:subagent:4c1d9e")).toBe("subagent");
  });

  it("recognizes internal sessions such as the skill workshop review", () => {
    expect(ephemeralSessionScope(
      "agent:vast:internal-session-effects:skill-workshop-review_e95ec48e",
    )).toBe("internal session");
  });

  it("leaves conversations alone", () => {
    for (const key of [
      "agent:vast:main",
      "agent:vast:discord:guild:1524917037191925871",
      "agent:bast:telegram:group:-100123",
      "agent:vast:explicit:abc",
      "agent:cron:main",
      undefined,
      "",
    ]) {
      expect(ephemeralSessionScope(key)).toBe(null);
    }
  });
});

describe("sessionExclusionReason", () => {
  it("names the session scope", () => {
    expect(sessionExclusionReason(NONE, "agent:vast:cron:daily-digest"))
      .toBe("cron sessions do not use VC");
    expect(sessionExclusionReason(NONE, "agent:vast:subagent:4c1d9e"))
      .toBe("subagent sessions do not use VC");
  });

  it("names an excluded agent", () => {
    const excluded = buildExcludedAgentSet(["extractor"]).excluded;
    expect(sessionExclusionReason(excluded, "agent:extractor:main"))
      .toBe("agent 'extractor' is in excludeAgents");
  });

  it("returns null for a conversation of an admitted agent", () => {
    expect(sessionExclusionReason(NONE, "agent:vast:main")).toBe(null);
  });
});

describe("excludeSessions", () => {
  const sessions = buildExcludedAgentSet(["agent:bast:discord-alerts"]).excluded;

  it("excludes a listed session key, case-insensitively", () => {
    expect(sessionExclusionReason(NONE, "agent:bast:discord-alerts", sessions))
      .toBe("session is in excludeSessions");
    expect(sessionExclusionReason(NONE, "Agent:Bast:Discord-Alerts", sessions))
      .toBe("session is in excludeSessions");
  });

  it("matches the exact key, not a prefix, and leaves the agent's other sessions on VC", () => {
    for (const key of [
      "agent:bast:discord-alerts-kimi",
      "agent:bast:telegram:direct:8049932331",
      "agent:bast:main",
    ]) {
      expect(sessionExclusionReason(NONE, key, sessions)).toBe(null);
    }
  });

  it("excludes nothing when unset", () => {
    expect(sessionExclusionReason(NONE, "agent:bast:discord-alerts")).toBe(null);
  });
});
