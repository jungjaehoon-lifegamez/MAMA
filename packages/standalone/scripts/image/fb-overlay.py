#!/usr/bin/env python3
"""Render translated text over OCR regions and return the output path as JSON."""

import json
import os
import sys
from pathlib import Path


PADDING = 10
MIN_FONT_SIZE = 18


def font_candidates():
    configured = os.environ.get("MAMA_KOREAN_FONT")
    return [
        configured,
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    ]


def load_font(image_draw, text, max_width, start_size):
    from PIL import ImageFont

    for candidate in font_candidates():
        if not candidate or not Path(candidate).exists():
            continue
        size = max(start_size, MIN_FONT_SIZE)
        while size >= MIN_FONT_SIZE:
            font = ImageFont.truetype(candidate, size)
            bounds = image_draw.textbbox((0, 0), text, font=font)
            if bounds[2] - bounds[0] <= max_width or size == MIN_FONT_SIZE:
                return font
            size -= 1
    raise RuntimeError("Korean font not found; set MAMA_KOREAN_FONT")


def sample_text_color(array, points):
    import numpy

    x1 = max(min(point[0] for point in points), 0)
    y1 = max(min(point[1] for point in points), 0)
    x2 = min(max(point[0] for point in points), array.shape[1])
    y2 = min(max(point[1] for point in points), array.shape[0])
    region = array[y1:y2, x1:x2]
    if region.size == 0:
        return (20, 20, 20)
    dark_pixels = region.reshape(-1, 3)[region.mean(axis=2).flatten() < 80]
    if len(dark_pixels) < 3:
        return (20, 20, 20)
    return tuple(int(channel) for channel in dark_pixels.mean(axis=0))


def main():
    if len(sys.argv) < 3:
        raise ValueError("Usage: fb-overlay.py <image> <annotations.json> [output.png]")

    from PIL import Image, ImageDraw
    import numpy

    image_path = sys.argv[1]
    annotations_path = sys.argv[2]
    output_path = (
        sys.argv[3]
        if len(sys.argv) > 3
        else str(Path(image_path).with_name(f"{Path(image_path).stem}_KR.png"))
    )
    with open(annotations_path, encoding="utf-8") as handle:
        annotations = json.load(handle)

    original = Image.open(image_path).convert("RGB")
    image = original.copy()
    pixels = numpy.array(original)
    draw = ImageDraw.Draw(image)
    render_items = []

    for annotation in annotations:
        points = annotation["bbox"]
        translated = annotation.get("translated", "")
        if not translated:
            continue
        x1 = min(point[0] for point in points)
        y1 = min(point[1] for point in points)
        x2 = max(point[0] for point in points)
        y2 = max(point[1] for point in points)
        font = load_font(draw, translated, x2 - x1, int((y2 - y1) * 0.92))
        bounds = draw.textbbox((0, 0), translated, font=font)
        width = bounds[2] - bounds[0]
        height = bounds[3] - bounds[1]
        render_items.append(
            {
                "box": (
                    x1 - PADDING,
                    y1 - PADDING,
                    max(x2, x1 + width) + PADDING,
                    max(y2, y1 + height + 4) + PADDING,
                ),
                "text": translated,
                "font": font,
                "color": sample_text_color(pixels, points),
                "height": height,
            }
        )

    for item in render_items:
        draw.rectangle(list(item["box"]), fill=(255, 255, 255))
    for item in render_items:
        x1, y1, _x2, y2 = item["box"]
        text_y = y1 + ((y2 - y1) - item["height"]) // 2
        draw.text(
            (x1 + PADDING, text_y),
            item["text"],
            font=item["font"],
            fill=item["color"],
        )

    image.save(output_path, quality=95)
    print(json.dumps({"outputPath": output_path}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
