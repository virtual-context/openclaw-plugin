import { describe, expect, it } from "vitest";
import { mkdtempSync, promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHistoryImageLabeler } from "../image-labeler.js";

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Minimal valid PNG: solid color, RGB or RGBA when alpha is given. */
function makePng(width, height, [r, g, b, a]) {
  const bpp = a == null ? 3 : 4;
  const row = Buffer.alloc(1 + width * bpp);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * bpp] = r;
    row[2 + x * bpp] = g;
    row[3 + x * bpp] = b;
    if (bpp === 4) row[4 + x * bpp] = a;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = bpp === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const quiet = { info() {}, warn() {} };
const probeLabeler = createHistoryImageLabeler({ log: quiet });
const probe = await probeLabeler.probe();
const workspace = mkdtempSync(path.join(os.tmpdir(), "vc-labeler-"));
const inbound = path.join(workspace, "media", "inbound", "openclaw-staged-test");
await fs.mkdir(inbound, { recursive: true });
const tallSource = path.join(inbound, "input-IMG_0001---1111aaaa-2222-3333-4444-555555555555.png");
writeFileSync(tallSource, makePng(590, 1002, [30, 120, 200]));
const alphaSource = path.join(inbound, "input-IMG_0002---1111aaaa-2222-3333-4444-666666666666.png");
writeFileSync(alphaSource, makePng(300, 200, [200, 40, 40, 128]));

describe("BUG-005: image labeler", () => {
  it("rejects malformed refs and relative roots before touching the disk", async () => {
    const labeler = createHistoryImageLabeler({ log: quiet });
    await expect(labeler.label({ sourcePath: tallSource, ref: "IOIO-0101", workspaceDir: workspace }))
      .rejects.toThrow(/invalid ref/u);
    await expect(labeler.label({ sourcePath: tallSource, ref: "7K3M-P8QD", workspaceDir: "relative/dir" }))
      .rejects.toThrow(/absolute/u);
    await expect(labeler.label({ sourcePath: "relative.png", ref: "7K3M-P8QD", workspaceDir: workspace }))
      .rejects.toThrow(/absolute/u);
  });

  describe.skipIf(!probe.ok)("with the bundled Python worker", () => {
    it("appends a band above the pixels, caches by source bytes and ref, and keeps refs apart", async () => {
      const labeler = createHistoryImageLabeler({ log: quiet, maxEdge: 1200 });
      const first = await labeler.label({ sourcePath: tallSource, ref: "7K3M-P8QD", workspaceDir: workspace });
      expect(first.cached).toBe(false);
      expect(first.contentType).toBe("image/jpeg");
      expect(first.path.startsWith(path.join(workspace, "media", "inbound", "vc-labeled") + path.sep)).toBe(true);
      expect(path.basename(first.path)).toMatch(/^7K3M-P8QD-[0-9a-f]{12}\.jpg$/u);
      expect(first.width).toBe(590);
      expect(first.height).toBeGreaterThan(1002);
      const stat = await fs.stat(first.path);
      expect(stat.size).toBeGreaterThan(0);

      const again = await labeler.label({ sourcePath: tallSource, ref: "7K3M-P8QD", workspaceDir: workspace });
      expect(again.cached).toBe(true);
      expect(again.path).toBe(first.path);

      const other = await labeler.label({ sourcePath: tallSource, ref: "ABCD-EFGH", workspaceDir: workspace });
      expect(other.path).not.toBe(first.path);
    });

    it("keeps alpha sources as PNG and reports the resized geometry", async () => {
      const labeler = createHistoryImageLabeler({ log: quiet, maxEdge: 1200 });
      const result = await labeler.label({ sourcePath: alphaSource, ref: "PNGA-2345", workspaceDir: workspace });
      expect(result.contentType).toBe("image/png");
      const { width, height } = pngSize(await fs.readFile(result.path));
      expect(width).toBe(300);
      expect(height).toBeGreaterThan(200);
    });

    it("downsizes to the requested long edge before labeling", async () => {
      const labeler = createHistoryImageLabeler({ log: quiet, maxEdge: 400 });
      const result = await labeler.label({ sourcePath: tallSource, ref: "SMAL-LEDG", workspaceDir: workspace });
      expect(result.height).toBeLessThanOrEqual(400 + 60);
      expect(result.width).toBeLessThan(590);
    });

    it("surfaces worker failures as errors without leaving temp files", async () => {
      const labeler = createHistoryImageLabeler({ log: quiet });
      const broken = path.join(inbound, "broken.png");
      writeFileSync(broken, Buffer.from("not an image"));
      await expect(labeler.label({ sourcePath: broken, ref: "BRKN-2222", workspaceDir: workspace })).rejects.toThrow();
      const leftovers = (await fs.readdir(path.join(workspace, "media", "inbound", "vc-labeled")))
        .filter((name) => name.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    });
  });

  it("evicts the oldest derived copies past the quota but never fresh ones", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "vc-quota-"));
    const dir = path.join(root, "media", "inbound", "vc-labeled");
    await fs.mkdir(dir, { recursive: true });
    const old = path.join(dir, "OLDD-2222-aaaaaaaaaaaa.jpg");
    const older = path.join(dir, "OLDR-2222-bbbbbbbbbbbb.jpg");
    const fresh = path.join(dir, "FRSH-2222-cccccccccccc.jpg");
    for (const file of [old, older, fresh]) writeFileSync(file, Buffer.alloc(1000, 1));
    const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    await fs.utimes(older, past - 100, past - 100);
    await fs.utimes(old, past, past);
    const labeler = createHistoryImageLabeler({ log: quiet, quotaBytes: 2000 });
    await labeler.enforceQuota(dir);
    const remaining = (await fs.readdir(dir)).sort();
    expect(remaining).toEqual(["FRSH-2222-cccccccccccc.jpg", "OLDD-2222-aaaaaaaaaaaa.jpg"]);
  });
});
