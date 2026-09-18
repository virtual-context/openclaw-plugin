import { describe, expect, it, vi } from "vitest";
import { createSpeakerAttributedContextEngine } from "../attributed-context-engine.js";

const WS = "/ws";
const sessionKey = "agent:example:discord:channel:room-synthetic";
const target = { agentId: "example", sessionId: "session-synthetic", sessionKey };
const admission = { ...target, role: "user", entryId: "entry-current", logicalTurnId: "turn-current" };
const codex = { executionHost: { id: "codex-app-server", label: "Codex app-server harness" } };
const embedded = { executionHost: { id: "openclaw-embedded", label: "OpenClaw embedded runner" } };
const runtimeContext = { workspaceDir: WS };

const imageFact = (fileName) => ({
  path: `${WS}/media/inbound/openclaw-staged-x/input-${fileName.replace(/\.png$/u, "")}---1111aaaa-2222-3333-4444-555555555555.png`,
  contentType: "image/png",
  kind: "image",
  fileName,
  workspaceDir: WS,
});
const memberRow = (content, media) => ({
  role: "user",
  content,
  idempotencyKey: `channel-user:v1:${content}`,
  timestamp: Date.UTC(2026, 8, 18, 19, 6),
  __openclaw: {
    senderId: "member-a",
    senderName: "Member A",
    transport: { channel: "discord" },
    ...(media ? { media } : {}),
  },
});
const stubLabeler = () => ({
  label: vi.fn(async ({ ref, workspaceDir }) => ({
    path: `${workspaceDir}/media/inbound/vc-labeled/${ref}-deadbeef0000.jpg`,
    contentType: "image/jpeg",
  })),
  probe: vi.fn(async () => ({ ok: true })),
});
const make = (extra = {}) => createSpeakerAttributedContextEngine({
  delegateCompactionToRuntime: vi.fn(),
  captureTranscriptReadAdmission: () => undefined,
  historyImageLabeler: null,
  ...extra,
});

describe("BUG-005: Codex assemblies bind every history image to its message", () => {
  it("labels history images, repeats the ref in text and file name, and maps them for the developer", async () => {
    const earlier = memberRow("Here we go", [imageFact("IMG_1052.png")]);
    const labeler = stubLabeler();
    const log = { info: vi.fn(), warn: vi.fn() };
    const engine = make({ historyImageLabeler: labeler, log });
    const result = await engine.assemble({
      ...target, messages: [earlier], prompt: "new request", runtimeSettings: codex, runtimeContext,
    });
    const projected = result.messages[0];
    const fact = projected.__openclaw.media[0];
    const ref = /VCREF ([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})/u.exec(projected.content)?.[1];
    expect(ref).toBeTruthy();
    expect(labeler.label).toHaveBeenCalledWith({ sourcePath: earlier.__openclaw.media[0].path, ref, workspaceDir: WS });
    expect(fact.path).toBe(`${WS}/media/inbound/vc-labeled/${ref}-deadbeef0000.jpg`);
    expect(fact.url).toBe(fact.path);
    expect(fact.contentType).toBe("image/jpeg");
    expect(fact.fileName).toBe(`IMG_1052.png (VCREF ${ref})`);
    expect(projected.content).toContain('"actor_id":"actor:discord:member-a"');
    expect(projected.content).toContain(`[this message's image: VCREF ${ref} = "IMG_1052.png"]`);
    expect(result.systemPromptAddition).toContain("History image references for this turn");
    expect(result.systemPromptAddition).toContain(`- VCREF ${ref}: Member A, 2026-09-18 19:06 UTC, "IMG_1052.png"`);
    expect(result.systemPromptAddition).not.toMatch(/not attached|re-share/iu);
    expect(earlier.__openclaw.media[0].path).toContain("/openclaw-staged-x/");
    expect(earlier.content).toBe("Here we go");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("[vc:media] flat-projection host=codex-app-server: labeled 1 of 1"));
  });

  it("leaves embedded-host assemblies byte-identical", async () => {
    const earlier = memberRow("Here we go", [imageFact("IMG_1052.png")]);
    const labeler = stubLabeler();
    const result = await make({ historyImageLabeler: labeler }).assemble({
      ...target, sessionKey: "agent:example:main", messages: [earlier], prompt: "new request",
      runtimeSettings: embedded, runtimeContext,
    });
    expect(result.messages[0]).toBe(earlier);
    expect(result.systemPromptAddition).toBeUndefined();
    expect(labeler.label).not.toHaveBeenCalled();
  });

  it("preserves the unfenced trailing current row and labels only earlier rows", async () => {
    const earlier = memberRow("old screenshot", [imageFact("old.png")]);
    const current = memberRow("Here we go", [imageFact("IMG_1053.png")]);
    const labeler = stubLabeler();
    const result = await make({ historyImageLabeler: labeler }).assemble({
      ...target, messages: [earlier, current], prompt: "Here we go", runtimeSettings: codex, runtimeContext,
    });
    expect(result.messages[1]).toBe(current);
    expect(labeler.label).toHaveBeenCalledTimes(1);
    expect(result.messages[0].__openclaw.media[0].path).toContain("/vc-labeled/");
  });

  it("treats a fenced row as history even when its text equals the current request", async () => {
    const fencedRow = memberRow("same words", [imageFact("same.png")]);
    const labeler = stubLabeler();
    const engine = make({ historyImageLabeler: labeler, captureTranscriptReadAdmission: () => admission });
    const result = await engine.assemble({
      ...target, messages: [fencedRow], prompt: "same words",
      runtimeContext: { sessionTarget: target, workspaceDir: WS }, runtimeSettings: codex,
    });
    expect(labeler.label).toHaveBeenCalledTimes(1);
    expect(result.messages[0].__openclaw.media[0].path).toContain("/vc-labeled/");
  });

  it("keeps the original image and says so when labeling fails", async () => {
    const earlier = memberRow("Here we go", [imageFact("IMG_1052.png")]);
    const labeler = { label: vi.fn(async () => { throw new Error("worker timeout"); }) };
    const log = { info: vi.fn(), warn: vi.fn() };
    const result = await make({ historyImageLabeler: labeler, log }).assemble({
      ...target, messages: [earlier], prompt: "new request", runtimeSettings: codex, runtimeContext,
    });
    expect(result.messages[0].__openclaw.media[0]).toBe(earlier.__openclaw.media[0]);
    expect(result.messages[0].content).toContain('image "IMG_1052.png" is attached without a VCREF band');
    expect(result.systemPromptAddition).toContain("WITHOUT a VCREF band");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("error=worker timeout"));
  });

  it("lists the current request's images from the prompt envelope in the developer map", async () => {
    const earlier = memberRow("Here we go", [imageFact("IMG_1052.png")]);
    const current = imageFact("IMG_1053.png");
    const prompt = [
      `[media attached: ${current.path} (image/png) "IMG_1053.png"]`,
      "To send an image back, use the message tool. Keep caption in the text body.",
      "Look again big dawg",
    ].join("\n");
    const result = await make({ historyImageLabeler: stubLabeler() }).assemble({
      ...target, messages: [earlier], prompt, runtimeSettings: codex, runtimeContext,
    });
    expect(result.systemPromptAddition).toContain("The current request's images are attached last and carry no band.");
    expect(result.systemPromptAddition).toContain('Current request images (attached last, no band): 1 = "IMG_1053.png"');
    expect(result.systemPromptAddition).not.toMatch(/unlabeled/iu);
  });

  it("places the image map after the memory addition and omits it when there are no history images", async () => {
    const labeler = stubLabeler();
    const engine = make({ historyImageLabeler: labeler, buildMemorySystemPromptAddition: () => "MEMORY" });
    const withImages = await engine.assemble({
      ...target, messages: [memberRow("Here we go", [imageFact("IMG_1052.png")])], prompt: "new request",
      runtimeSettings: codex, runtimeContext,
    });
    expect(withImages.systemPromptAddition.startsWith("MEMORY\n\nHistory image references")).toBe(true);
    const withoutImages = await engine.assemble({
      ...target, messages: [memberRow("plain")], prompt: "new request", runtimeSettings: codex, runtimeContext,
    });
    expect(withoutImages.systemPromptAddition).toBe("MEMORY");
  });
});
