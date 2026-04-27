/**
 * OT4.2 — vitest unit + fetch-mock: VCMERGE / VCMERGE PREVIEW commands reach the
 * cloud REST endpoint with the correct URL and body construction.
 *
 * Pins the spec contract from plan §6.2 OT4.2: the plugin's `vcPost` against
 * `/api/v1/context/prepare` produces:
 *   - URL: `<baseUrl>/api/v1/context/prepare?vckey=<key>&vcconv=<sessionId>`
 *   - Method: POST
 *   - Content-Type: application/json
 *   - Body: JSON-serialized `{messages: [...], model?: string}`
 *
 * `buildUrl` is exercised as a pure function (URL construction). `vcPost` is
 * exercised against fetch-mock to assert the wire-level request shape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fetchMock from "fetch-mock";
import { buildUrl, vcPost } from "../index.js";

describe("OT4.2 — buildUrl URL construction", () => {
  it("produces vckey + vcconv query params", () => {
    const url = buildUrl("https://api.virtual-context.com", "/api/v1/context/prepare", "vc-test-key", "session-abc");
    expect(url).toBe("https://api.virtual-context.com/api/v1/context/prepare?vckey=vc-test-key&vcconv=session-abc");
  });

  it("strips trailing slashes from baseUrl", () => {
    const url = buildUrl("https://api.virtual-context.com/", "/api/v1/context/prepare", "k", "s");
    expect(url).toBe("https://api.virtual-context.com/api/v1/context/prepare?vckey=k&vcconv=s");
  });

  it("URL-encodes vckey and sessionId for safety", () => {
    const url = buildUrl("https://api.virtual-context.com", "/api/v1/tools/vc_find_quote", "vc key with spaces", "session/with/slashes");
    expect(url).toContain("vckey=vc%20key%20with%20spaces");
    expect(url).toContain("vcconv=session%2Fwith%2Fslashes");
  });

  it("omits vcconv when sessionId is falsy", () => {
    const url = buildUrl("https://api.virtual-context.com", "/api/v1/context/prepare", "k", null);
    expect(url).toBe("https://api.virtual-context.com/api/v1/context/prepare?vckey=k");
    expect(url).not.toContain("vcconv");
  });
});

describe("OT4.2 — vcPost fires correct wire request for VCMERGE / VCMERGE PREVIEW", () => {
  beforeEach(() => {
    fetchMock.mockGlobal();
  });

  afterEach(() => {
    fetchMock.unmockGlobal();
    fetchMock.removeRoutes();
    fetchMock.clearHistory();
  });

  it("POSTs VCMERGE prompt to /api/v1/context/prepare with vckey+vcconv", async () => {
    fetchMock.post(
      "https://api.virtual-context.com/api/v1/context/prepare?vckey=key&vcconv=sess",
      { vc_command: "merge", message: "merge ok" },
    );

    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "VCMERGE INTO target-label" }] }],
      model: "openai-direct/gpt-5.5",
    };
    const result = await vcPost("https://api.virtual-context.com", "/api/v1/context/prepare", "key", "sess", body, 60000, null);

    expect(result).toEqual({ vc_command: "merge", message: "merge ok" });

    const lastCall = fetchMock.callHistory.lastCall();
    expect(lastCall.url).toBe("https://api.virtual-context.com/api/v1/context/prepare?vckey=key&vcconv=sess");
    // fetch-mock v12 normalizes method + header keys to lowercase in callHistory;
    // HTTP itself treats both case-insensitively, so we assert lowercase here.
    expect(lastCall.options.method.toLowerCase()).toBe("post");
    expect(lastCall.options.headers["content-type"]).toBe("application/json");

    const sentBody = JSON.parse(lastCall.options.body);
    expect(sentBody.messages).toHaveLength(1);
    expect(sentBody.messages[0].content[0].text).toBe("VCMERGE INTO target-label");
    expect(sentBody.model).toBe("openai-direct/gpt-5.5");
  });

  it("POSTs VCMERGE PREVIEW prompt with the same wire shape", async () => {
    fetchMock.post(
      "https://api.virtual-context.com/api/v1/context/prepare?vckey=key&vcconv=sess",
      { vc_command: "merge_preview", message: "would merge 358 turns" },
    );

    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "VCMERGE PREVIEW target-label" }] }],
    };
    const result = await vcPost("https://api.virtual-context.com", "/api/v1/context/prepare", "key", "sess", body, 60000, null);

    expect(result.vc_command).toBe("merge_preview");
    const lastCall = fetchMock.callHistory.lastCall();
    const sentBody = JSON.parse(lastCall.options.body);
    expect(sentBody.messages[0].content[0].text).toBe("VCMERGE PREVIEW target-label");
  });

  it("throws on non-2xx response with the cloud-provided body text", async () => {
    fetchMock.post(
      "https://api.virtual-context.com/api/v1/context/prepare?vckey=key&vcconv=sess",
      { status: 500, body: "internal error" },
    );

    await expect(
      vcPost("https://api.virtual-context.com", "/api/v1/context/prepare", "key", "sess", { messages: [] }, 15000, null),
    ).rejects.toThrow(/VC API 500/);
  });
});
