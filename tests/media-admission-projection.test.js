import { describe, expect, it } from "vitest";
import {
  discordBodyAdmissionProjection,
  stripLeadingOpenClawMediaScaffold,
} from "../index.js";

const OBSERVED_MEDIA_HINT =
  "To send an image back, use the message tool with structured media fields such as media, mediaUrl, path, or filePath. Keep caption in the text body.";
const CURRENT_MEDIA_HINT =
  "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Avoid absolute paths (MEDIA:/...) and ~ paths - they are blocked for security. Keep caption in the text body.";

describe("Discord media admission projection", () => {
  it("projects the observed OpenClaw envelope and clean caption identically", () => {
    const wrapped = [
      "[media attached: /root/.openclaw/media/inbound/Screenshot.jpg (image/jpeg)]",
      OBSERVED_MEDIA_HINT,
      "caption text",
    ].join("\r\n");

    expect(discordBodyAdmissionProjection(wrapped))
      .toBe(discordBodyAdmissionProjection("caption text"));
  });

  it("recognizes current multi-attachment lines including bracketed filenames", () => {
    const wrapped = [
      "[media attached: 2 files]",
      "[media attached 1/2: /root/Screenshot [1].jpg (image/jpeg)]",
      "[media attached 2/2: /root/panel.png (image/png)]",
      CURRENT_MEDIA_HINT,
      "caption text",
    ].join("\n");

    expect(stripLeadingOpenClawMediaScaffold(wrapped)).toBe("caption text");
  });

  it("never strips an unpaired hint or a second hint-shaped caption", () => {
    expect(stripLeadingOpenClawMediaScaffold(
      `${OBSERVED_MEDIA_HINT}\ncaption text`,
    )).toBe(`${OBSERVED_MEDIA_HINT}\ncaption text`);

    const wrapped = [
      "[media attached: /root/example.jpg (image/jpeg)]",
      OBSERVED_MEDIA_HINT,
      OBSERVED_MEDIA_HINT,
      "caption text",
    ].join("\n");
    expect(stripLeadingOpenClawMediaScaffold(wrapped))
      .toBe(`${OBSERVED_MEDIA_HINT}\ncaption text`);
  });

  it("keeps caption mismatches strict after removing the envelope", () => {
    const wrapped = [
      "[media attached: /root/example.jpg (image/jpeg)]",
      OBSERVED_MEDIA_HINT,
      "caption A",
    ].join("\n");

    expect(discordBodyAdmissionProjection(wrapped))
      .not.toBe(discordBodyAdmissionProjection("caption B"));
  });
});
