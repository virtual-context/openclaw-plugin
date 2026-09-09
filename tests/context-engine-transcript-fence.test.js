import { describe, expect, it, vi } from "vitest";
import { createSpeakerAttributedContextEngine, registerSpeakerAttributedContextEngine } from "../attributed-context-engine.js";
const sessionKey = "agent:example:discord:channel:room-synthetic";
const target = { agentId: "example", sessionId: "session-synthetic", sessionKey };
const admission = { ...target, role: "user", entryId: "entry-current", logicalTurnId: "turn-current" };
const historical = { role: "user", content: "same words", __openclaw: { senderId: "member-a", senderName: "Member A", transport: { channel: "discord" } } };
const make = (capture, extra = {}) => createSpeakerAttributedContextEngine({ delegateCompactionToRuntime: vi.fn(), captureTranscriptReadAdmission: capture, ...extra });
describe("BUG-002: current-turn transcript fencing", () => {
  it("declares both fence and idempotent advancement contracts required by the host", () => {
    const engine = make(() => admission);
    expect(engine.info.transcriptSemantics).toEqual({ currentTurnFence: "before-current-turn-entry-v1", turnAdvancementIdempotency: "atomic-idempotent-v1" });
    expect(typeof engine.commitTurn).toBe("function");
  });
  it("attributes a fenced historical row even when its text equals the current request", async () => {
    const capture = vi.fn(() => admission); const onCurrentSpeaker = vi.fn();
    const engine = make(capture, { onCurrentSpeaker });
    const result = await engine.assemble({ ...target, messages: [historical], prompt: "same words", runtimeContext: { sessionTarget: target } });
    expect(capture).toHaveBeenCalledWith(target);
    expect(result.messages[0].content).toContain('"actor_id":"actor:discord:member-a"');
    expect(result.messages[0].content).toContain("same words");
    expect(result.messages).toHaveLength(1);
    expect(historical.content).toBe("same words");
    expect(onCurrentSpeaker).toHaveBeenCalledWith(expect.objectContaining({ speaker: null }));
  });
  it("does not infer the current author from a fenced previous author", async () => {
    const handoff=vi.fn();const engine=make(() => admission,{onCurrentSpeaker:handoff});
    await engine.assemble({...target,messages:[historical],prompt:"same words",runtimeContext:{sessionTarget:target}});
    expect(handoff.mock.calls[0][0].speaker).toBeNull();
  });
  it("keeps legacy current-row bytes and identity when there is no active fence", async () => {
    const handoff=vi.fn();const engine=make(() => undefined,{onCurrentSpeaker:handoff});
    const result=await engine.assemble({...target,messages:[historical],prompt:"same words",runtimeContext:{sessionTarget:target}});
    expect(result.messages[0]).toBe(historical);
    expect(handoff.mock.calls[0][0].speaker).toMatchObject({senderId:"member-a"});
  });
  it("reads the active fence for embedded group assembly without runtimeContext", async () => {
    const embeddedTarget = { ...target, sessionKey: "agent:example:telegram:group:room-synthetic" };
    const capture = vi.fn(() => ({ ...admission, ...embeddedTarget }));
    const handoff = vi.fn();
    const previous = { ...historical, __openclaw: { senderId: "member-a", senderName: "Member A", transport: { channel: "telegram" } } };
    const result = await make(capture, { onCurrentSpeaker: handoff }).assemble({
      sessionId: embeddedTarget.sessionId, sessionKey: embeddedTarget.sessionKey,
      messages: [previous], prompt: "same words",
    });
    expect(capture).toHaveBeenCalledWith(embeddedTarget);
    expect(result.messages[0].content).toContain('"actor_id":"actor:telegram:member-a"');
    expect(handoff.mock.calls[0][0].speaker).toBeNull();
    expect(previous.content).toBe("same words");
  });
  it("rejects another embedded conversation's receipt with the same agent and session id", async () => {
    const engine = make(() => ({ ...admission, sessionKey: "agent:example:telegram:group:other-room" }));
    await expect(engine.assemble({
      sessionId: target.sessionId, sessionKey: target.sessionKey,
      messages: [historical], prompt: "same words",
    })).rejects.toThrow(/admission.*target/i);
  });
  it("rejects a mismatched captured admission instead of borrowing another transcript's current author", async () => {
    const engine=make(()=>({...admission,sessionId:"different-session"}));
    await expect(engine.assemble({...target,messages:[historical],prompt:"same words",runtimeContext:{sessionTarget:target}})).rejects.toThrow(/admission.*target/i);
  });
  it("surfaces admission-reader failures instead of silently reverting to current-row guessing", async () => {
    const engine=make(()=>{throw new Error("fence reader failed");});
    await expect(engine.assemble({...target,messages:[historical],prompt:"same words",runtimeContext:{sessionTarget:target}})).rejects.toThrow("fence reader failed");
  });
  it("registered assembly preserves mixed historical authors and the separate current body", async () => {
    let factory;
    const registerContextEngine = vi.fn((_id, create) => { factory = create; });
    registerSpeakerAttributedContextEngine({ registerContextEngine }, {
      delegateCompactionToRuntime: vi.fn(), captureTranscriptReadAdmission: () => admission,
    });
    const legacy = { role: "user", content: "earlier detail", senderId: "member-b", senderName: "Member B", sourceChannel: "discord" };
    const messages = [legacy, historical];
    const prompt = "same words";
    const result = await factory().assemble({ ...target, messages, prompt, runtimeContext: { sessionTarget: target } });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toContain('"actor_id":"actor:discord:member-b"');
    expect(result.messages[1].content).toContain('"actor_id":"actor:discord:member-a"');
    expect(messages).toEqual([legacy, historical]);
    expect(prompt).toBe("same words");
  });
  it("stateless advancement has no ingestion, compaction, or current-speaker side effects on replay", async () => {
    const compact=vi.fn();const handoff=vi.fn();const engine=make(()=>admission,{delegateCompactionToRuntime:compact,onCurrentSpeaker:handoff});
    const messages=[historical,{role:"assistant",content:"synthetic reply"}];const before=JSON.stringify(messages);
    const turn={...target,advancementKey:"turn-current",admission,messages};
    await expect(engine.commitTurn(turn)).resolves.toEqual({status:"committed"});
    await expect(engine.commitTurn(turn)).resolves.toEqual({status:"committed"});
    expect(JSON.stringify(messages)).toBe(before);expect(compact).not.toHaveBeenCalled();expect(handoff).not.toHaveBeenCalled();
  });
});
