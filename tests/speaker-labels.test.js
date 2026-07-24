/**
 * Speaker labeling for multi-party chats.
 *
 * OpenClaw strips senderName before the prompt hook runs, so the model reads
 * every prior human turn as one anonymous `user`. In a group chat that means
 * the agent attributes whatever the last human said to whoever is speaking
 * now. The session JSONL still carries senderName, so identity is recovered
 * from there and stamped into the message text the model actually reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => process.env.VC_TEST_HOME ?? actual.homedir() };
});

import { readSpeakerNames, labelSpeakers } from "../index.js";

const SID = "1fd564f6-3705-4c54-9fbf-2b59ed05d31a";
const SESSION_KEY = "agent:vast:discord:channel:1524920218944798940";

let home;

function writeSession(entries) {
  const dir = join(home, ".openclaw", "agents", "vast", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${SID}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

/** One inbound user record, shaped as OpenClaw writes it. */
function userEntry(senderName, text) {
  return { type: "message", message: { role: "user", senderName, content: text } };
}

function assistantEntry(text) {
  return { type: "message", message: { role: "assistant", content: text } };
}

const textOf = (msg) =>
  typeof msg.content === "string"
    ? msg.content
    : msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vc-speaker-"));
  process.env.VC_TEST_HOME = home;
});

afterEach(() => {
  delete process.env.VC_TEST_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("readSpeakerNames", () => {
  it("maps each message's text to whoever wrote it", () => {
    writeSession([
      userEntry("BigTex", "@Vast give us the macros here"),
      assistantEntry("600 to 650 calories"),
      userEntry("NuncaBob", "The protein is 30g of protein per scoop."),
      userEntry("optics", "you are such a fuck up"),
    ]);
    const names = readSpeakerNames(SESSION_KEY, SID);
    expect(names.get("@Vast give us the macros here")).toBe("BigTex");
    expect(names.get("The protein is 30g of protein per scoop.")).toBe("NuncaBob");
    expect(names.get("you are such a fuck up")).toBe("optics");
  });

  it("drops text two different people wrote verbatim", () => {
    writeSession([
      userEntry("BigTex", "lol"),
      userEntry("NuncaBob", "lol"),
      userEntry("optics", "distinct message"),
    ]);
    const names = readSpeakerNames(SESSION_KEY, SID);
    // Guessing between two speakers would invent the misattribution.
    expect(names.has("lol")).toBe(false);
    expect(names.get("distinct message")).toBe("optics");
  });

  it("returns null when the session has no file", () => {
    expect(readSpeakerNames(SESSION_KEY, SID)).toBeNull();
  });
});

describe("labelSpeakers", () => {
  it("names every speaker in a group chat", () => {
    const names = new Map([
      ["The protein is 30g per scoop.", "NuncaBob"],
      ["you are such a fuck up", "optics"],
    ]);
    const out = labelSpeakers(
      [
        { role: "user", content: [{ type: "text", text: "The protein is 30g per scoop." }] },
        { role: "assistant", content: [{ type: "text", text: "You're right, I fucked that up." }] },
        { role: "user", content: [{ type: "text", text: "you are such a fuck up" }] },
      ],
      names,
    );
    expect(textOf(out[0])).toBe("NuncaBob: The protein is 30g per scoop.");
    // The assistant's own turn is never relabeled.
    expect(textOf(out[1])).toBe("You're right, I fucked that up.");
    expect(textOf(out[2])).toBe("optics: you are such a fuck up");
  });

  it("regression: the label claim stays with the person who made it", () => {
    // The screenshot. NuncaBob asserted the label; optics then insulted the
    // bot. Unlabeled, both turns read as one speaker, and the bot told optics
    // it had argued with them about "your own label".
    const names = new Map([
      ["The protein is 30g of protein per scoop.", "NuncaBob"],
      ["you are such a fuck up", "optics"],
    ]);
    const out = labelSpeakers(
      [
        { role: "user", content: [{ type: "text", text: "The protein is 30g of protein per scoop." }] },
        { role: "user", content: [{ type: "text", text: "you are such a fuck up" }] },
      ],
      names,
    );
    const speakers = out.map((m) => textOf(m).split(":")[0]);
    expect(speakers).toEqual(["NuncaBob", "optics"]);
    expect(new Set(speakers).size).toBe(2);
  });

  it("leaves a one-on-one chat byte-identical", () => {
    const names = new Map([["hey", "optics"]]);
    const messages = [{ role: "user", content: [{ type: "text", text: "hey" }] }];
    const out = labelSpeakers(messages, names);
    expect(out).toBe(messages);
  });

  it("is a no-op on a second pass over already-labeled history", () => {
    const names = new Map([["hi there", "BigTex"], ["yo", "NuncaBob"]]);
    const once = labelSpeakers(
      [
        { role: "user", content: [{ type: "text", text: "hi there" }] },
        { role: "user", content: [{ type: "text", text: "yo" }] },
      ],
      names,
    );
    const twice = labelSpeakers(once, names);
    // A message must keep the exact text it was first stored under, or the
    // memory layer hashes it as a different message and stores it twice.
    expect(twice.map(textOf)).toEqual(once.map(textOf));
    expect(textOf(twice[0])).toBe("BigTex: hi there");
  });

  it("does not mutate the caller's messages", () => {
    const names = new Map([["a", "BigTex"], ["b", "NuncaBob"]]);
    const original = { role: "user", content: [{ type: "text", text: "a" }] };
    const out = labelSpeakers([original], names);
    expect(textOf(original)).toBe("a");
    expect(textOf(out[0])).toBe("BigTex: a");
  });

  it("leaves a message unlabeled when its author is unknown", () => {
    const names = new Map([["known", "BigTex"], ["other", "NuncaBob"]]);
    const out = labelSpeakers(
      [{ role: "user", content: [{ type: "text", text: "who said this" }] }],
      names,
    );
    expect(textOf(out[0])).toBe("who said this");
  });

  it("handles string content", () => {
    const names = new Map([["plain", "BigTex"], ["x", "NuncaBob"]]);
    const out = labelSpeakers([{ role: "user", content: "plain" }], names);
    expect(out[0].content).toBe("BigTex: plain");
  });

  it("passes messages through when no names are available", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(labelSpeakers(messages, null)).toBe(messages);
  });
});
