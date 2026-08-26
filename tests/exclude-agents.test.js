/**
 * excludeAgents: per-agent exclusion from Virtual Context.
 *
 * The providers allowlist is model-keyed, so it cannot exclude an AGENT: a
 * fallback onto a listed model silently re-admits an agent the operator meant
 * to keep out, and a model shared by two agents cannot separate them at all.
 * excludeAgents is agent-keyed and holds across model fallbacks.
 *
 * buildExcludedAgentSet validates the config; sessionAgentExcluded answers
 * per turn from the session key's `agent:<agentId>:` namespace, the same
 * derivation selectVcKey uses for per-agent key routing. Matching is
 * case-insensitive on both sides: for an exclusion knob a case mismatch must
 * fail toward exclusion, not toward admission.
 */
import { describe, it, expect } from "vitest";
import {
  buildExcludedAgentSet,
  sessionAgentExcluded,
} from "../index.js";

describe("buildExcludedAgentSet", () => {
  it("builds a lowercased set from a valid list", () => {
    const r = buildExcludedAgentSet(["Extractor", "intake"]);
    expect(r.excluded).toEqual(new Set(["extractor", "intake"]));
    expect(r.invalid).toEqual([]);
    expect(r.malformed).toBe(false);
  });

  it("treats absent config as no exclusions, not a fault", () => {
    for (const cfg of [undefined, null, []]) {
      const r = buildExcludedAgentSet(cfg);
      expect(r.excluded.size).toBe(0);
      expect(r.malformed).toBe(false);
    }
  });

  it("names invalid entries instead of dropping them silently", () => {
    const r = buildExcludedAgentSet(["coach", "", 42, "  "]);
    expect(r.excluded).toEqual(new Set(["coach"]));
    expect(r.invalid).toEqual(["", 42, "  "]);
  });

  it("flags a wholesale-malformed config instead of excluding nothing quietly", () => {
    // A malformed exclusion list fails OPEN at runtime (nothing can be
    // excluded when the intent is unreadable), so the flag exists to make
    // register() say so on every call rather than silently un-excluding.
    for (const cfg of ["coach", { coach: true }, 7]) {
      const r = buildExcludedAgentSet(cfg);
      expect(r.malformed).toBe(true);
      expect(r.excluded.size).toBe(0);
    }
  });

  it("trims and deduplicates ids", () => {
    const r = buildExcludedAgentSet([" coach ", "coach", "COACH"]);
    expect(r.excluded).toEqual(new Set(["coach"]));
    expect(r.invalid).toEqual([]);
  });
});

describe("sessionAgentExcluded", () => {
  const EXCLUDED = buildExcludedAgentSet(["extractor"]).excluded;

  it("excludes a session in the agent's namespace", () => {
    expect(
      sessionAgentExcluded(EXCLUDED, "agent:extractor:extract:d63512bb"),
    ).toBe(true);
  });

  it("excludes the sk:-prefixed form of the same namespace", () => {
    expect(
      sessionAgentExcluded(EXCLUDED, "sk:agent:extractor:extract:d63512bb"),
    ).toBe(true);
  });

  it("matches case-insensitively in both directions", () => {
    expect(
      sessionAgentExcluded(EXCLUDED, "agent:Extractor:extract:d63512bb"),
    ).toBe(true);
    const mixed = buildExcludedAgentSet(["ExTractor"]).excluded;
    expect(
      sessionAgentExcluded(mixed, "agent:extractor:extract:d63512bb"),
    ).toBe(true);
  });

  it("does not exclude other agents", () => {
    expect(
      sessionAgentExcluded(EXCLUDED, "agent:coach:telegram:group:g1"),
    ).toBe(false);
  });

  it("does not exclude a session key with no agent namespace", () => {
    // Exclusion is BY agent id; a key that carries none is not that agent.
    // Same fallback shape as selectVcKey, which routes such keys to the
    // deployment-wide key.
    for (const key of ["web:channel:c1", "", undefined, null]) {
      expect(sessionAgentExcluded(EXCLUDED, key)).toBe(false);
    }
  });

  it("answers false at zero cost when nothing is excluded", () => {
    expect(
      sessionAgentExcluded(new Set(), "agent:extractor:extract:d63512bb"),
    ).toBe(false);
    expect(
      sessionAgentExcluded(null, "agent:extractor:extract:d63512bb"),
    ).toBe(false);
  });
});
