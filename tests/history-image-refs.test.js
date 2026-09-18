import { describe, expect, it, vi } from "vitest";
import {
  REF_ALPHABET,
  REF_RE,
  attachmentDisplayName,
  buildHistoryImageDeveloperNote,
  collectHistoryImageBindings,
  formatBindingTime,
  historyImageRef,
  hostFlattensHistoryImages,
  isImageMediaFact,
  labeledFileName,
  messageBindingKey,
  parseCurrentRequestImages,
  projectHistoryImageBindings,
  projectHistoryImagesForFlatHost,
  resolveLabelWorkspaceDir,
} from "../history-image-refs.js";

const WS = "/ws";
const staged = (name, uuid = "54924743-c21f-4eaf-861f-cdfd9c1ae17b") =>
  `${WS}/media/inbound/openclaw-staged-98fa65be/input-${name}---${uuid}.png`;
const imageFact = (fileName, extra = {}) => ({
  path: staged(fileName.replace(/\.png$/u, "")),
  url: staged(fileName.replace(/\.png$/u, "")),
  contentType: "image/png",
  kind: "image",
  fileName,
  workspaceDir: WS,
  ...extra,
});
const row = (content, media, extra = {}) => ({
  role: "user",
  content,
  idempotencyKey: `channel-user:v1:${content}`,
  timestamp: Date.UTC(2026, 8, 9, 20, 49),
  __openclaw: {
    senderId: "member-a",
    senderName: "Member A",
    transport: { channel: "discord" },
    ...(media ? { media } : {}),
  },
  ...extra,
});
const codex = { executionHost: { id: "codex-app-server" } };
const outcomesFor = (bindings, make) => new Map(bindings.map((b) => [b.id, make(b)]));

describe("BUG-005: history image refs", () => {
  it("uses an alphabet without I/1/O/0 and stable 4-4 refs", () => {
    expect(REF_ALPHABET).not.toMatch(/[I1O0]/u);
    const ref = historyImageRef("session", "key", 0);
    expect(ref).toMatch(REF_RE);
    expect(historyImageRef("session", "key", 0)).toBe(ref);
    expect(historyImageRef("session", "key", 1)).not.toBe(ref);
    expect(historyImageRef("other", "key", 0)).not.toBe(ref);
    expect(historyImageRef("session", "key", 0, 1)).not.toBe(ref);
  });

  it("recognizes only the Codex app-server host", () => {
    expect(hostFlattensHistoryImages(codex)).toBe(true);
    expect(hostFlattensHistoryImages({ executionHost: { id: " Codex-App-Server " } })).toBe(true);
    expect(hostFlattensHistoryImages({ executionHost: { id: "openclaw-embedded" } })).toBe(false);
    expect(hostFlattensHistoryImages(undefined)).toBe(false);
  });

  it("classifies image facts by kind, then content type, then extension", () => {
    expect(isImageMediaFact({ kind: "image" })).toBe(true);
    expect(isImageMediaFact({ kind: "document", contentType: "image/png" })).toBe(false);
    expect(isImageMediaFact({ contentType: "image/png" })).toBe(true);
    expect(isImageMediaFact({ contentType: "application/pdf" })).toBe(false);
    expect(isImageMediaFact({ path: "/x/IMG.HEIC" })).toBe(true);
    expect(isImageMediaFact({ url: "https://example.test/a.webp?x=1" })).toBe(true);
    expect(isImageMediaFact({ path: "/x/notes.txt" })).toBe(false);
    expect(isImageMediaFact(null)).toBe(false);
  });

  it("derives readable display names and strips unsafe characters", () => {
    expect(attachmentDisplayName(imageFact("IMG_0978.png"))).toBe("IMG_0978.png");
    expect(attachmentDisplayName({ path: staged("IMG_0957") })).toBe("IMG_0957.png");
    expect(attachmentDisplayName({ fileName: 'weird ["name"]\u202e.png' })).toBe("weird name .png");
    expect(attachmentDisplayName({ fileName: "x".repeat(200) }).length).toBeLessThanOrEqual(82);
    expect(attachmentDisplayName({})).toBe("image");
  });

  it("keys a message by idempotency key with a host-fact fallback", () => {
    expect(messageBindingKey(row("a", [imageFact("a.png")]))).toBe("channel-user:v1:a");
    const legacy = { role: "user", content: "x", timestamp: 5, __openclaw: { senderId: "s", media: [{ path: "/p/a.png", contentType: "image/png" }] } };
    expect(messageBindingKey(legacy)).toBe("fallback|5|s|/p/a.png");
  });

  it("collects one binding per image fact and skips what is not history imagery", () => {
    const pdf = { path: `${WS}/media/inbound/x/coa.pdf`, contentType: "application/pdf", kind: "document", fileName: "coa.pdf" };
    const messages = [
      { role: "assistant", content: "hi", __openclaw: { media: [imageFact("nope.png")] } },
      row("mixed", [imageFact("label.png"), pdf]),
      { role: "user", content: [{ type: "tool_result", toolUseId: "t", content: "ok" }], __openclaw: { media: [imageFact("tool.png")] } },
      row("two", [imageFact("IMG_0978.png"), imageFact("IMG_0979.png")]),
      row("plain"),
      row("current", [imageFact("IMG_1053.png")]),
    ];
    const bindings = collectHistoryImageBindings(messages, { sessionId: "s", prompt: "current" });
    expect(bindings.map((b) => [b.messageIndex, b.factIndex, b.displayName])).toEqual([
      [1, 0, "label.png"],
      [3, 0, "IMG_0978.png"],
      [3, 1, "IMG_0979.png"],
    ]);
    expect(new Set(bindings.map((b) => b.ref)).size).toBe(3);
    expect(bindings[0].speakerName).toBe("Member A");
    expect(bindings[0].sourcePath).toBe(staged("label"));
    // Fenced hosts pass no prompt: the trailing row is history like any other.
    expect(collectHistoryImageBindings(messages, { sessionId: "s" })).toHaveLength(4);
  });

  it("projects labeled facts onto derived copies and keeps failed facts byte-identical", () => {
    const original = row("two", [imageFact("IMG_0978.png"), imageFact("IMG_0979.png")]);
    const messages = [original];
    const bindings = collectHistoryImageBindings(messages, { sessionId: "s" });
    const outcomes = new Map([
      [bindings[0].id, { path: `${WS}/media/inbound/vc-labeled/${bindings[0].ref}-abc.jpg`, contentType: "image/jpeg" }],
      [bindings[1].id, { error: "boom" }],
    ]);
    const { messages: projected, labeled, unlabeled } = projectHistoryImageBindings(messages, bindings, outcomes);
    expect(labeled).toBe(1);
    expect(unlabeled).toBe(1);
    const media = projected[0].__openclaw.media;
    expect(media[0].path).toBe(`${WS}/media/inbound/vc-labeled/${bindings[0].ref}-abc.jpg`);
    expect(media[0].url).toBe(media[0].path);
    expect(media[0].contentType).toBe("image/jpeg");
    expect(media[0].fileName).toBe(labeledFileName(bindings[0]));
    expect(media[0].fileName).toContain(`VCREF ${bindings[0].ref}`);
    expect(media[1]).toBe(original.__openclaw.media[1]);
    expect(projected[0].content).toContain(`[this message's image: VCREF ${bindings[0].ref} = "IMG_0978.png"]`);
    expect(projected[0].content).toContain('image "IMG_0979.png" is attached without a VCREF band');
    expect(projected[0].__openclaw.senderId).toBe("member-a");
    expect(original.content).toBe("two");
    expect(original.__openclaw.media[0].path).toBe(staged("IMG_0978"));
  });

  it("appends the ref line as a text part for array content", () => {
    const messages = [row([{ type: "text", text: "look" }], [imageFact("a.png")])];
    const bindings = collectHistoryImageBindings(messages, { sessionId: "s" });
    const outcomes = outcomesFor(bindings, (b) => ({ path: `${WS}/media/inbound/vc-labeled/${b.ref}.jpg`, contentType: "image/jpeg" }));
    const { messages: projected } = projectHistoryImageBindings(messages, bindings, outcomes);
    expect(projected[0].content).toHaveLength(2);
    expect(projected[0].content[1].type).toBe("text");
    expect(projected[0].content[1].text).toContain(`VCREF ${bindings[0].ref}`);
  });

  it("writes the developer map with the binding rule, labeled refs, and unlabeled identities", () => {
    const messages = [row("one", [imageFact("IMG_0978.png")]), row("two", [imageFact("IMG_0999.png")])];
    const bindings = collectHistoryImageBindings(messages, { sessionId: "s" });
    const outcomes = new Map([
      [bindings[0].id, { path: "/x.jpg", contentType: "image/jpeg" }],
      [bindings[1].id, { error: "nope" }],
    ]);
    const note = buildHistoryImageDeveloperNote(bindings, outcomes);
    expect(note).toContain("ONLY by an exact VCREF match");
    expect(note).toContain("The current request's images are attached last and carry no band.");
    expect(note).not.toContain("Current request images");
    expect(note).toContain(`- VCREF ${bindings[0].ref}: Member A, 2026-09-09 20:49 UTC, "IMG_0978.png"`);
    expect(note).toContain("WITHOUT a VCREF band");
    expect(note).toContain('- Member A, 2026-09-09 20:49 UTC, "IMG_0999.png"');
    expect(buildHistoryImageDeveloperNote([], outcomes)).toBe("");
    expect(formatBindingTime("garbage")).toBe("");
  });

  it("resolves the write root from the runtime workspace only when it contains the sources", () => {
    const bindings = collectHistoryImageBindings([row("a", [imageFact("a.png")])], { sessionId: "s" });
    expect(resolveLabelWorkspaceDir({ workspaceDir: WS }, bindings)).toBe(WS);
    expect(resolveLabelWorkspaceDir({ workspaceDir: "/elsewhere" }, bindings)).toBe(WS);
    expect(resolveLabelWorkspaceDir(undefined, bindings)).toBe(WS);
    const remote = collectHistoryImageBindings(
      [row("r", [{ url: "https://cdn.example/a.png", contentType: "image/png" }])],
      { sessionId: "s" },
    );
    expect(remote[0].sourcePath).toBe("");
    expect(resolveLabelWorkspaceDir(undefined, remote)).toBeNull();
  });

  it("parses the current request's image attachments from the host envelope", () => {
    const single = [
      `[media attached: ${staged("IMG_1053")} (image/png) "IMG_1053.png"]`,
      "To send an image back, use the message tool. Keep caption in the text body.",
      "Here we go @Vast",
    ].join("\n");
    expect(parseCurrentRequestImages(single)).toEqual(["IMG_1053.png"]);
    const multi = [
      "[media attached: 3 files]",
      `[media attached 1/3: ${staged("IMG_0978")} (image/png) "IMG_0978.png"]`,
      `[media attached 2/3: ${WS}/media/inbound/x/coa.pdf (application/pdf) "coa.pdf"]`,
      `[media attached 3/3: ${staged("IMG_0979")} (image/png)]`,
      "caption",
    ].join("\n");
    expect(parseCurrentRequestImages(multi)).toEqual(["IMG_0978.png", "IMG_0979.png"]);
    expect(parseCurrentRequestImages(`plain text\n[media attached: ${staged("x")} (image/png)]`)).toEqual([]);
    expect(parseCurrentRequestImages("")).toEqual([]);
    expect(parseCurrentRequestImages(undefined)).toEqual([]);
  });

  it("names the current request's images positively in the developer map", () => {
    const messages = [row("one", [imageFact("IMG_0978.png")])];
    const bindings = collectHistoryImageBindings(messages, { sessionId: "s" });
    const outcomes = outcomesFor(bindings, () => ({ path: "/x.jpg", contentType: "image/jpeg" }));
    const note = buildHistoryImageDeveloperNote(bindings, outcomes, { currentImages: ["IMG_1053.png", "IMG_1054.png"] });
    expect(note).toContain("The current request's images are attached last and carry no band.");
    expect(note).toContain('Current request images (attached last, no band): 1 = "IMG_1053.png", 2 = "IMG_1054.png"');
    expect(note).not.toMatch(/unlabeled|not attached|re-share/iu);
  });

  it("orchestrates labeling for the Codex host and leaves other hosts untouched", async () => {
    const messages = [row("one", [imageFact("IMG_0978.png")]), row("plain")];
    const label = vi.fn(async ({ ref, workspaceDir }) => ({
      path: `${workspaceDir}/media/inbound/vc-labeled/${ref}-h.jpg`,
      contentType: "image/jpeg",
    }));
    const log = { info: vi.fn(), warn: vi.fn() };
    const result = await projectHistoryImagesForFlatHost(messages, {
      sessionId: "s", runtimeSettings: codex, runtimeContext: { workspaceDir: WS },
    }, { labeler: { label }, log });
    expect(label).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: staged("IMG_0978"), workspaceDir: WS }));
    expect(result.labeled).toBe(1);
    expect(result.messages[0].__openclaw.media[0].path).toContain("/vc-labeled/");
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.note).toContain("History image references for this turn");
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/labeled 1 of 1 history image\(s\) across 1 message\(s\)/u));

    const embedded = await projectHistoryImagesForFlatHost(messages, {
      sessionId: "s", runtimeSettings: { executionHost: { id: "openclaw-embedded" } },
    }, { labeler: { label }, log });
    expect(embedded.messages).toBe(messages);
    expect(embedded.note).toBe("");
  });

  it("keeps the original image and reports it when the labeler fails or is missing", async () => {
    const messages = [row("one", [imageFact("IMG_0978.png")])];
    const log = { info: vi.fn(), warn: vi.fn() };
    const failing = { label: vi.fn(async () => { throw new Error("python exploded"); }) };
    const failed = await projectHistoryImagesForFlatHost(messages, {
      sessionId: "s", runtimeSettings: codex, runtimeContext: { workspaceDir: WS },
    }, { labeler: failing, log });
    expect(failed.unlabeled).toBe(1);
    expect(failed.messages[0].__openclaw.media[0]).toBe(messages[0].__openclaw.media[0]);
    expect(failed.messages[0].content).toContain("without a VCREF band");
    expect(failed.note).toContain("WITHOUT a VCREF band");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("error=python exploded"));

    const none = await projectHistoryImagesForFlatHost(messages, {
      sessionId: "s", runtimeSettings: codex, runtimeContext: { workspaceDir: WS },
    }, { labeler: null, log });
    expect(none.unlabeled).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("labeler unavailable"));
  });
});
