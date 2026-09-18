import { describe, expect, it, vi } from "vitest";
import {
  createSpeakerAttributedContextEngine,
  detachHistoryImagesForFlatProjection,
  hostFlattensHistoryImages,
} from "../attributed-context-engine.js";

const sessionKey = "agent:example:discord:channel:room-synthetic";
const target = { agentId: "example", sessionId: "session-synthetic", sessionKey };
const admission = { ...target, role: "user", entryId: "entry-current", logicalTurnId: "turn-current" };
const codex = { executionHost: { id: "codex-app-server", label: "Codex app-server harness" } };
const embedded = { executionHost: { id: "openclaw-embedded", label: "OpenClaw embedded runner" } };
const staged = "/workspace/media/inbound/openclaw-staged-98fa65be/input-IMG_0978---54924743-c21f-4eaf-861f-cdfd9c1ae17b.png";

const imageFact = (fileName, extra = {}) => ({
  path: `/workspace/media/inbound/${fileName}`,
  url: `/workspace/media/inbound/${fileName}`,
  contentType: "image/png",
  kind: "image",
  fileName,
  workspaceDir: "/workspace",
  ...extra,
});
const memberRow = (content, media, extra = {}) => ({
  role: "user",
  content,
  idempotencyKey: `channel-user:v1:${content}`,
  __openclaw: {
    senderId: "member-a",
    senderName: "Member A",
    transport: { channel: "discord" },
    ...(media ? { media, mediaImageLayout: { kind: "trailing" } } : {}),
  },
  ...extra,
});
const make = (extra = {}) => createSpeakerAttributedContextEngine({
  delegateCompactionToRuntime: vi.fn(),
  captureTranscriptReadAdmission: () => undefined,
  ...extra,
});

describe("BUG-005: flat-projection hosts receive only the current request's images", () => {
  it("recognizes the Codex app-server host and nothing else", () => {
    expect(hostFlattensHistoryImages(codex)).toBe(true);
    expect(hostFlattensHistoryImages({ executionHost: { id: " Codex-App-Server " } })).toBe(true);
    expect(hostFlattensHistoryImages(embedded)).toBe(false);
    expect(hostFlattensHistoryImages(undefined)).toBe(false);
    expect(hostFlattensHistoryImages({})).toBe(false);
  });

  it("detaches history image facts under Codex and notes them by speaker and name", async () => {
    const earlier = memberRow("Here we go", [imageFact("IMG_1053.png")]);
    const log = { info: vi.fn(), warn: vi.fn() };
    const engine = make({ log });
    const result = await engine.assemble({
      ...target, messages: [earlier], prompt: "new request", runtimeSettings: codex,
    });
    const projected = result.messages[0];
    expect(projected).not.toBe(earlier);
    expect(projected.__openclaw.media).toBeUndefined();
    expect(projected.__openclaw.mediaImageLayout).toBeUndefined();
    expect(projected.__openclaw.mediaImagePruned).toBe(true);
    expect(projected.__openclaw.senderId).toBe("member-a");
    expect(projected.content).toContain("Here we go");
    expect(projected.content).toContain(
      '[earlier image from Member A: "IMG_1053.png"; not attached to this request]',
    );
    expect(projected.content).toContain('"actor_id":"actor:discord:member-a"');
    expect(result.systemPromptAddition).toContain("Attached images belong only to the current user request");
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(
      /\[vc:media\] flat-projection host=codex-app-server: detached 1 earlier image\(s\) from 1 history message\(s\)/,
    ));
    // The host's row is never mutated.
    expect(earlier.__openclaw.media).toHaveLength(1);
    expect(earlier.content).toBe("Here we go");
  });

  it("keeps non-image facts and only removes the images from a mixed attachment set", () => {
    const pdf = { path: "/workspace/media/inbound/coa.pdf", contentType: "application/pdf", kind: "document", fileName: "coa.pdf" };
    const row = memberRow("COA for product.", [imageFact("label.png"), pdf]);
    const { message, detached } = detachHistoryImagesForFlatProjection(row);
    expect(detached).toBe(1);
    expect(message.__openclaw.media).toEqual([pdf]);
    expect(message.__openclaw.mediaImagePruned).toBe(true);
    expect(message.content).toContain('[earlier image from Member A: "label.png"; not attached to this request]');
  });

  it("leaves embedded-host and unknown-host assemblies byte-identical", async () => {
    const earlier = memberRow("Here we go", [imageFact("IMG_1053.png")]);
    for (const runtimeSettings of [embedded, undefined]) {
      const engine = make();
      const result = await engine.assemble({
        ...target,
        sessionKey: "agent:example:main",
        messages: [earlier],
        prompt: "new request",
        ...(runtimeSettings ? { runtimeSettings } : {}),
      });
      expect(result.messages[0]).toBe(earlier);
      expect(result.systemPromptAddition).toBeUndefined();
    }
  });

  it("preserves the unfenced trailing current row and its images while detaching earlier rows", async () => {
    const earlier = memberRow("old screenshot", [imageFact("old.png")]);
    const current = memberRow("Here we go", [imageFact("IMG_1053.png")]);
    const result = await make().assemble({
      ...target, messages: [earlier, current], prompt: "Here we go", runtimeSettings: codex,
    });
    expect(result.messages[1]).toBe(current);
    expect(result.messages[1].__openclaw.media).toHaveLength(1);
    expect(result.messages[0].__openclaw.media).toBeUndefined();
    expect(result.messages[0].content).toContain('"old.png"; not attached to this request');
  });

  it("treats a fenced row as history even when its text equals the current request", async () => {
    const fencedRow = memberRow("same words", [imageFact("same.png")]);
    const engine = make({ captureTranscriptReadAdmission: () => admission });
    const result = await engine.assemble({
      ...target,
      messages: [fencedRow],
      prompt: "same words",
      runtimeContext: { sessionTarget: target },
      runtimeSettings: codex,
    });
    expect(result.messages[0].__openclaw.media).toBeUndefined();
    expect(result.messages[0].content).toContain('"same.png"; not attached to this request');
  });

  it("derives a readable name from the host's staged path when no fileName is stored", () => {
    const row = memberRow("[User sent media without caption]", [{ path: staged, contentType: "image/png" }]);
    const { message, detached } = detachHistoryImagesForFlatProjection(row);
    expect(detached).toBe(1);
    expect(message.content).toContain('[earlier image from Member A: "IMG_0978.png"; not attached to this request]');
  });

  it("names multiple images in one note and reports the count", () => {
    const row = memberRow("sounds like some BS", [imageFact("IMG_0978.png"), imageFact("IMG_0979.png")]);
    const { message, detached } = detachHistoryImagesForFlatProjection(row);
    expect(detached).toBe(2);
    expect(message.content).toContain(
      '[earlier 2 images from Member A: "IMG_0978.png", "IMG_0979.png"; not attached to this request]',
    );
  });

  it("removes inline image parts from array content and notes them", () => {
    const row = {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    };
    const { message, detached } = detachHistoryImagesForFlatProjection(row);
    expect(detached).toBe(1);
    expect(message.content.some((part) => part.type === "image")).toBe(false);
    expect(message.content.at(-1)).toEqual({
      type: "text",
      text: '[earlier image: "inline image"; not attached to this request]',
    });
    expect(message.__openclaw.mediaImagePruned).toBe(true);
    expect(row.content).toHaveLength(2);
  });

  it("never touches assistant rows, tool-protocol rows, or image-free user rows", () => {
    const assistant = { role: "assistant", content: "reply", __openclaw: { media: [imageFact("x.png")] } };
    const tool = {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }, { type: "image", data: "AAAA" }],
    };
    const plain = memberRow("no image here");
    for (const row of [assistant, tool, plain]) {
      const { message, detached } = detachHistoryImagesForFlatProjection(row);
      expect(message).toBe(row);
      expect(detached).toBe(0);
    }
  });

  it("appends the attachment note after the memory addition without duplicating it", async () => {
    const earlier = memberRow("Here we go", [imageFact("IMG_1053.png")]);
    const engine = make({ buildMemorySystemPromptAddition: () => "MEMORY" });
    const withImages = await engine.assemble({
      ...target, messages: [earlier], prompt: "new request", runtimeSettings: codex,
    });
    expect(withImages.systemPromptAddition.startsWith("MEMORY\n\nAttached images belong only")).toBe(true);
    const withoutImages = await engine.assemble({
      ...target, messages: [memberRow("plain")], prompt: "new request", runtimeSettings: codex,
    });
    expect(withoutImages.systemPromptAddition).toBe("MEMORY");
  });
});
