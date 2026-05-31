import { describe, it, expect } from "vitest";
import { hoistSystemPreamble } from "../index.js";

describe("hoistSystemPreamble", () => {
  it("hoists a leading role:system string into body.system", () => {
    const body = {
      messages: [
        { role: "system", content: "<system-reminder>preamble</system-reminder>" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    };
    const len = hoistSystemPreamble(body);
    expect(len).toBe("<system-reminder>preamble</system-reminder>".length);
    expect(body.system).toBe("<system-reminder>preamble</system-reminder>");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("concatenates with existing body.system string", () => {
    const body = {
      system: "existing",
      messages: [
        { role: "system", content: "appended" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    };
    hoistSystemPreamble(body);
    expect(body.system).toBe("existing\nappended");
    expect(body.messages).toHaveLength(1);
  });

  it("appends to existing body.system block array", () => {
    const body = {
      system: [{ type: "text", text: "existing" }],
      messages: [
        { role: "system", content: "new block" },
      ],
    };
    hoistSystemPreamble(body);
    expect(body.system).toEqual([
      { type: "text", text: "existing" },
      { type: "text", text: "new block" },
    ]);
    expect(body.messages).toHaveLength(0);
  });

  it("extracts joined text from content-block array form", () => {
    const body = {
      messages: [
        { role: "system", content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ] },
      ],
    };
    hoistSystemPreamble(body);
    expect(body.system).toBe("first\nsecond");
    expect(body.messages).toHaveLength(0);
  });

  it("no-op when messages[0] is not a system message", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    };
    const len = hoistSystemPreamble(body);
    expect(len).toBeUndefined();
    expect(body.system).toBeUndefined();
    expect(body.messages).toHaveLength(1);
  });

  it("no-op when system message has empty content", () => {
    const body = {
      messages: [
        { role: "system", content: "" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    };
    const len = hoistSystemPreamble(body);
    expect(len).toBeUndefined();
    expect(body.system).toBeUndefined();
    expect(body.messages).toHaveLength(2);
  });

  it("no-op on null body, empty body, or empty messages", () => {
    expect(hoistSystemPreamble(null)).toBeUndefined();
    expect(hoistSystemPreamble({})).toBeUndefined();
    const body = { messages: [] };
    expect(hoistSystemPreamble(body)).toBeUndefined();
    expect(body.messages).toHaveLength(0);
  });

  it("only hoists the leading entry; trailing system messages are left alone", () => {
    const body = {
      messages: [
        { role: "system", content: "first preamble" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: "second preamble" },
      ],
    };
    hoistSystemPreamble(body);
    expect(body.system).toBe("first preamble");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("system");
  });
});
