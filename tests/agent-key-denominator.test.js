/**
 * agentKeyFiles: configured-vs-loaded accounting.
 *
 * buildAgentKeyIndex drops an unusable entry and continues, so the index can
 * be short without anything downstream noticing. `agentKeys=2` in the register
 * summary reads as health whether two or twenty entries were configured, and
 * the only other trace of a dropped entry is a routing line that is ABSENT --
 * which is what nobody greps for.
 *
 * summarizeAgentKeyRouting supplies the denominator and names the ids that
 * fell back to the deployment-wide key, so a reader learns WHICH tenant
 * boundary is gone rather than only that the count looks plausible.
 */
import { describe, it, expect } from "vitest";
import {
  buildAgentKeyIndex,
  summarizeAgentKeyRouting,
} from "../index.js";

const VALID = `vc-${"a".repeat(40)}`;
const OTHER = `vc-${"b".repeat(40)}`;

/** buildAgentKeyIndex with an injected reader, so no files are touched. */
function indexFrom(cfg, files) {
  return buildAgentKeyIndex(cfg, null, (path) => {
    if (!(path in files)) {
      const err = new Error(`ENOENT: ${path}`);
      err.code = "ENOENT";
      throw err;
    }
    return files[path];
  });
}

describe("summarizeAgentKeyRouting", () => {
  it("reports a clean load with matching counts and no missing ids", () => {
    const cfg = { coach: "/keys/coach", intake: "/keys/intake" };
    const index = indexFrom(cfg, { "/keys/coach": VALID, "/keys/intake": OTHER });

    expect(summarizeAgentKeyRouting(cfg, index)).toEqual({
      configured: 2,
      loaded: 2,
      missing: [],
      malformedConfig: false,
    });
  });

  it("names the agent whose keyfile could not be read", () => {
    // The production failure: a path that was never copied to a new host.
    const cfg = { coach: "/keys/coach", intake: "/keys/never-copied" };
    const index = indexFrom(cfg, { "/keys/coach": VALID });

    const summary = summarizeAgentKeyRouting(cfg, index);
    expect(summary.configured).toBe(2);
    expect(summary.loaded).toBe(1);
    expect(summary.missing).toEqual(["intake"]);
  });

  it("names an agent whose keyfile is present but malformed", () => {
    // A truncated or placeholder file authenticates as nothing; it must be
    // counted as missing rather than silently loaded.
    const cfg = { coach: "/keys/coach" };
    const index = indexFrom(cfg, { "/keys/coach": "not-a-vc-key" });

    expect(summarizeAgentKeyRouting(cfg, index).missing).toEqual(["coach"]);
    expect(summarizeAgentKeyRouting(cfg, index).loaded).toBe(0);
  });

  it("counts entries rejected for their id or their missing path", () => {
    const cfg = { "bad:id": "/keys/a", noPath: "", fine: "/keys/fine" };
    const index = indexFrom(cfg, { "/keys/a": VALID, "/keys/fine": VALID });

    const summary = summarizeAgentKeyRouting(cfg, index);
    expect(summary.configured).toBe(3);
    expect(summary.loaded).toBe(1);
    expect(summary.missing.sort()).toEqual(["bad:id", "noPath"]);
  });

  it("reports zero-of-zero without flagging a malformed config", () => {
    // No agentKeyFiles at all is the normal deployment, not a fault.
    expect(summarizeAgentKeyRouting(undefined, new Map())).toEqual({
      configured: 0,
      loaded: 0,
      missing: [],
      malformedConfig: false,
    });
  });

  it("flags a wholesale-rejected config instead of reporting zero of zero", () => {
    // buildAgentKeyIndex rejects a non-object outright, so there are no ids to
    // list. Reporting 0/0 here would read as "nothing was asked for", which is
    // the opposite of what happened.
    const summary = summarizeAgentKeyRouting(["coach"], indexFrom(["coach"], {}));
    expect(summary.malformedConfig).toBe(true);
    expect(summary.configured).toBe(0);
    expect(summary.missing).toEqual([]);
  });

  it("never reports more loaded than configured", () => {
    // The denominator only helps if it bounds the numerator; a summary that
    // can print 3/2 is not an instrument.
    const cfg = { coach: "/keys/coach" };
    const index = indexFrom(cfg, { "/keys/coach": VALID });
    const summary = summarizeAgentKeyRouting(cfg, index);
    expect(summary.loaded).toBeLessThanOrEqual(summary.configured);
  });
});
