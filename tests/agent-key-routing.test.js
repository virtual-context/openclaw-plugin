/**
 * Per-agent VC key routing.
 *
 * A single deployment-wide vcKey authenticates EVERY agent on the gateway.
 * Pointing it at one agent's tenant therefore points ALL agents there, which is
 * what broke Bast on 2026-08-12. These tests pin the selection logic: an agent
 * with its own key file uses that key, everything else keeps the global key.
 *
 * buildAgentKeyIndex takes an injectable reader so no test touches the disk.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildAgentKeyIndex,
  selectVcKey,
  allConfiguredVcKeys,
} from "../index.js";

const GLOBAL = "vc-1111111111111111111111111111111111111111";
const GYM = "vc-2222222222222222222222222222222222222222";
const OTHER = "vc-3333333333333333333333333333333333333333";

const reader = (files) => (path) => {
  if (!(path in files)) {
    const err = new Error(`ENOENT: ${path}`);
    err.code = "ENOENT";
    throw err;
  }
  return files[path];
};

const quietLog = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });

describe("buildAgentKeyIndex", () => {
  it("reads a valid key file and indexes it by agent id", () => {
    const idx = buildAgentKeyIndex(
      { gymbrobot: "/keys/gym" },
      quietLog(),
      reader({ "/keys/gym": `${GYM}\n` }),
    );
    expect(idx.get("gymbrobot")).toBe(GYM);
    expect(idx.size).toBe(1);
  });

  it("absent config yields an empty index", () => {
    expect(buildAgentKeyIndex(undefined, quietLog(), reader({})).size).toBe(0);
    expect(buildAgentKeyIndex(null, quietLog(), reader({})).size).toBe(0);
  });

  it("rejects a non-object config wholesale", () => {
    const log = quietLog();
    expect(buildAgentKeyIndex(["gymbrobot"], log, reader({})).size).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });

  // A bad entry must not take VC down for every other agent.
  it("skips an unreadable key file and keeps the other entries", () => {
    const log = quietLog();
    const idx = buildAgentKeyIndex(
      { gymbrobot: "/keys/gym", ghost: "/keys/missing" },
      log,
      reader({ "/keys/gym": GYM }),
    );
    expect(idx.get("gymbrobot")).toBe(GYM);
    expect(idx.has("ghost")).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });

  it("rejects a key file whose contents are not vc-<40hex>", () => {
    const log = quietLog();
    const idx = buildAgentKeyIndex(
      { gymbrobot: "/keys/gym" },
      log,
      reader({ "/keys/gym": "vc-tooshort" }),
    );
    expect(idx.size).toBe(0);
    expect(log.error).toHaveBeenCalled();
  });

  it.each([
    ["empty agent id", { "": "/keys/gym" }],
    ["agent id containing a colon", { "agent:gymbrobot": "/keys/gym" }],
    ["missing path", { gymbrobot: "" }],
    ["non-string path", { gymbrobot: 42 }],
  ])("skips an invalid entry: %s", (_label, cfg) => {
    const log = quietLog();
    const idx = buildAgentKeyIndex(cfg, log, reader({ "/keys/gym": GYM }));
    expect(idx.size).toBe(0);
  });
});

describe("selectVcKey", () => {
  const idx = new Map([["gymbrobot", GYM]]);

  it("routes the configured agent to its own key", () => {
    expect(selectVcKey("agent:gymbrobot:web:direct:u1:conv:c1", GLOBAL, idx))
      .toBe(GYM);
  });

  // The regression this whole change exists to prevent.
  it("leaves every other agent on the global key", () => {
    for (const key of [
      "agent:bastkid-dedicated:telegram:group:-5156869263",
      "agent:bastkid-dedicated:main",
      "agent:vast:discord:channel:123",
      "agent:vast:cron:job-uuid",
    ]) {
      expect(selectVcKey(key, GLOBAL, idx)).toBe(GLOBAL);
    }
  });

  it("falls back to the global key for absent or unparseable session keys", () => {
    for (const key of ["", null, undefined, "not-a-session-key", "agent:"]) {
      expect(selectVcKey(key, GLOBAL, idx)).toBe(GLOBAL);
    }
  });

  it("an empty index is exactly the pre-change behaviour", () => {
    expect(selectVcKey("agent:gymbrobot:web:direct:u1:conv:c1", GLOBAL, new Map()))
      .toBe(GLOBAL);
    expect(selectVcKey("agent:gymbrobot:web:direct:u1:conv:c1", GLOBAL, undefined))
      .toBe(GLOBAL);
  });

  it("matches the agent id exactly, not by prefix", () => {
    expect(selectVcKey("agent:gymbrobot-staging:web:direct:u1:conv:c1", GLOBAL, idx))
      .toBe(GLOBAL);
  });

  it("resolves through an sk:-prefixed key too", () => {
    expect(selectVcKey("sk:agent:gymbrobot:web:direct:u1", GLOBAL, idx)).toBe(GYM);
  });
});

describe("allConfiguredVcKeys", () => {
  // Each key owns a separate completion-outbox directory, so a startup drain
  // must run per key or an agent's queued completions never deliver.
  it("returns the global key plus every distinct agent key", () => {
    const keys = allConfiguredVcKeys(
      GLOBAL,
      new Map([["gymbrobot", GYM], ["other", OTHER]]),
    );
    expect(keys).toEqual([GLOBAL, GYM, OTHER]);
  });

  it("de-duplicates an agent key equal to the global key", () => {
    expect(allConfiguredVcKeys(GLOBAL, new Map([["a", GLOBAL]]))).toEqual([GLOBAL]);
  });

  it("is just the global key when no agent keys are configured", () => {
    expect(allConfiguredVcKeys(GLOBAL, new Map())).toEqual([GLOBAL]);
    expect(allConfiguredVcKeys(GLOBAL, undefined)).toEqual([GLOBAL]);
  });

  it("drops empty keys rather than emitting a bogus outbox scope", () => {
    expect(allConfiguredVcKeys("", new Map([["gymbrobot", GYM]]))).toEqual([GYM]);
  });
});
