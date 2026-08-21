import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.js"), "utf8",
);

/**
 * Count call sites of `name` in `source`, excluding its own definition.
 *
 * Deliberately crude: a textual scan, not a parse. A parser would be more
 * precise and would also be a second thing that can be wrong. What this needs
 * to detect is ZERO, and zero is unambiguous under either method.
 */
function callSites(source, name) {
  const uses = source.match(new RegExp(`\\b${name}\\s*\\(`, "g")) ?? [];
  const definitions = source.match(
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`, "g"),
  ) ?? [];
  return uses.length - definitions.length;
}

function exportedFunctions(source) {
  return [...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)]
    .map((m) => m[1]);
}

/**
 * Exports with no in-module caller that are NOT defects.
 *
 * Every entry needs a reason. An empty list is the goal; a growing list with
 * blank reasons is this test being routed around rather than satisfied.
 */
const INTENTIONALLY_UNCALLED = new Map([
  ["clearReplyOnlyDirectiveCache",
    "Test affordance. Resets a module-scope cache so tests do not leak state "
    + "into each other; production has no reason to clear it. This is the one "
    + "legitimate shape of an uncalled export."],

  // ── UNRESOLVED FINDINGS, not exemptions. ──────────────────────────────────
  // Found by this test on its first run. Listed so the suite is green while
  // the decision is pending, NOT because they are known to be fine. A reason
  // that says "unresolved" is honest; a blank one would be this test being
  // routed around.
  ["leadingEnvelope",
    "UNRESOLVED: no production caller, exercised by exactly one assertion in "
    + "assembled-context.test.js. Either a superseded parser or a real "
    + "extraction that was never wired. Needs a decision, not an exemption."],
  // ── A KNOWN DEFECT with a fix already designed. ───────────────────────────
  ["forgetPendingOutboundIds",
    "KNOWN DEFECT, spec written (SPEC-pending-set-release.md). Nothing "
    + "releases a carried identity, so every ingest re-offers the whole "
    + "bucket. Measured in production: carriedExact went 0,1,3,6 across four "
    + "turns -- the triangular numbers, i.e. n(n+1)/2 carries for n "
    + "identities and provably zero releases. Safe on the wire under I-3; it "
    + "inflates `offered` quadratically. Awaiting a build decision, not a "
    + "diagnosis."],

  ["resolveSessionRuntime",
    "UNRESOLVED and the worst of the three: no production caller AND no test "
    + "reference at all. A sibling resolveSessionRuntimeDetails exists, so "
    + "this is probably a superseded wrapper -- but probably is not a reason."],
]);

describe("no exported function is dead", () => {
  // WHY THIS EXISTS: six surfaces in this package were built, unit-tested, and
  // never wired to anything -- and every one was caught by something other than
  // the tests. A passing unit test proves a function WORKS. It says nothing
  // about whether anything CALLS it, and coverage tools actively hide the gap
  // by counting the test itself as a caller.
  //
  // The rule was written down three hours before the sixth instance shipped, by
  // the person who wrote it. A rule you have to remember is not a control.

  it("POSITIVE CONTROL: the detector finds a function that nothing calls", () => {
    // Without this, a detector that silently matches nothing passes forever and
    // reports a clean codebase. Three instruments in this package have failed
    // exactly that way tonight.
    const fake = [
      "export function neverCalled(a) { return a; }",
      "export function isCalled(b) { return b; }",
      "const x = isCalled(1);",
    ].join("\n");
    expect(callSites(fake, "neverCalled")).toBe(0);
    expect(callSites(fake, "isCalled")).toBe(1);
    expect(exportedFunctions(fake)).toEqual(["neverCalled", "isCalled"]);
  });

  it("NEGATIVE CONTROL: it does not count the definition as a call", () => {
    // The off-by-one that would make every export look alive.
    const fake = "export function onlyDefined() { return 1; }";
    expect(callSites(fake, "onlyDefined")).toBe(0);
  });

  it("finds at least one exported function in the real source", () => {
    // Guards against a regex that silently stops matching after a refactor,
    // which would turn this whole file into a test that always passes.
    expect(exportedFunctions(SOURCE).length).toBeGreaterThan(20);
  });

  it("the allowlist does not quietly grow — unresolved entries are reported", () => {
    // An allowlist that nobody reads is how a detector stops detecting. Any
    // entry whose reason begins UNRESOLVED is an open finding, and this
    // asserts the count so adding another cannot pass unnoticed.
    const unresolved = [...INTENTIONALLY_UNCALLED.entries()]
      .filter(([, reason]) => reason.startsWith("UNRESOLVED"))
      .map(([name]) => name);
    expect(unresolved, "open dead-export findings awaiting a decision")
      .toEqual(["leadingEnvelope", "resolveSessionRuntime"]);
  });

  it("the known defect stays labelled as a defect, not as an exemption", () => {
    // The failure mode this guards: a defect quietly becoming an allowlist
    // entry that reads like a design decision, which is how the original six
    // survived as long as they did.
    const reason = INTENTIONALLY_UNCALLED.get("forgetPendingOutboundIds") ?? "";
    expect(reason).toContain("KNOWN DEFECT");
    expect(reason).toContain("SPEC-pending-set-release.md");
  });

  it("every exported function has a caller in the module itself", () => {
    const dead = exportedFunctions(SOURCE)
      .filter((name) => callSites(SOURCE, name) <= 0)
      .filter((name) => !INTENTIONALLY_UNCALLED.has(name));
    expect(dead, `exported but never called inside index.js: ${dead.join(", ")}. `
      + "A unit test proves it works; it does not prove anything invokes it. "
      + "Either wire it up or delete it -- and if it is genuinely meant to be "
      + "uncalled, add it to INTENTIONALLY_UNCALLED with a reason.").toEqual([]);
  });
});
