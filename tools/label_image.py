#!/usr/bin/env python3
"""Append a VCREF band above an image so a model can bind it to its message.

    label_image.py probe
    label_image.py label --in SRC --out DST --ref XXXX-XXXX [--max-edge 1200]

Prints exactly one JSON object on stdout. Exit status 0 only when {"ok": true}.
The band is added ABOVE the pixels (canvas extended), never painted over them.
"""
import argparse
import json
import os
import re
import sys

MAX_INPUT_BYTES = 30 * 1024 * 1024
MAX_PIXELS = 60_000_000
REF_RE = re.compile(r"^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$")
FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
)


def load_pil():
    from PIL import Image, ImageDraw, ImageFont, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    heif = False
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
        heif = True
    except Exception:
        heif = False
    return Image, ImageDraw, ImageFont, ImageOps, heif


def find_font():
    for candidate in FONT_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return None


def probe():
    Image, _draw, _font, _ops, heif = load_pil()
    Image.init()
    extensions = Image.registered_extensions()
    wanted = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".heic", ".heif")
    formats = sorted({extensions[e] for e in wanted if e in extensions and extensions[e] in Image.OPEN})
    import PIL

    return {"ok": True, "pillow": PIL.__version__, "heif": heif, "font": find_font(), "formats": formats}


def label(src, dst, ref, max_edge):
    if not REF_RE.match(ref):
        raise ValueError("invalid ref")
    size = os.path.getsize(src)
    if size > MAX_INPUT_BYTES:
        raise ValueError(f"source too large: {size} bytes")
    Image, ImageDraw, ImageFont, ImageOps, _heif = load_pil()
    with Image.open(src) as opened:
        opened.load()  # first frame of animated inputs
        image = ImageOps.exif_transpose(opened) or opened
        has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
        image = image.convert("RGBA" if has_alpha else "RGB")
    width, height = image.size
    long_edge = max(width, height)
    if long_edge > max_edge:
        scale = max_edge / float(long_edge)
        image = image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.LANCZOS)
        width, height = image.size
    band = max(44, round(0.05 * max(width, height)))
    text = f"VCREF {ref}"
    font_path = find_font()
    pad = max(8, band // 5)

    def make_font(px):
        if font_path:
            return ImageFont.truetype(font_path, px)
        return ImageFont.load_default(size=px)

    font_size = max(14, round(band * 0.6))
    font = make_font(font_size)
    measure = ImageDraw.Draw(image)
    while font_size > 10:
        left, top, right, bottom = measure.textbbox((0, 0), text, font=font)
        if (right - left) + 2 * pad <= width:
            break
        font_size -= 2
        font = make_font(font_size)
    mode = image.mode
    black = (0, 0, 0, 255) if mode == "RGBA" else (0, 0, 0)
    white = (255, 255, 255, 255) if mode == "RGBA" else (255, 255, 255)
    canvas = Image.new(mode, (width, height + band), black)
    canvas.paste(image, (0, band))
    draw = ImageDraw.Draw(canvas)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    draw.text((pad, (band - (bottom - top)) // 2 - top), text, font=font, fill=white)
    if mode == "RGBA":
        canvas.save(dst, format="PNG", optimize=True)
        content_type = "image/png"
    else:
        canvas.save(dst, format="JPEG", quality=88, optimize=True)
        content_type = "image/jpeg"
    return {
        "ok": True,
        "width": width,
        "height": height + band,
        "band": band,
        "fontSize": font_size,
        "contentType": content_type,
        "bytes": os.path.getsize(dst),
    }


def main(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("command", choices=("probe", "label"))
    parser.add_argument("--in", dest="src")
    parser.add_argument("--out", dest="dst")
    parser.add_argument("--ref")
    parser.add_argument("--max-edge", dest="max_edge", type=int, default=1200)
    args = parser.parse_args(argv)
    try:
        if args.command == "probe":
            result = probe()
        else:
            if not (args.src and args.dst and args.ref):
                raise ValueError("label requires --in, --out and --ref")
            result = label(args.src, args.dst, args.ref, max(64, args.max_edge))
    except Exception as error:  # noqa: BLE001 - reported as data, never a traceback
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
