#!/usr/bin/env python3
"""Extract OCR regions as JSON for MAMA image translation tools."""

import json
import sys


def main():
    if len(sys.argv) < 2:
        raise ValueError("Usage: ocr-image.py <image_path> [--lang ja,en]")

    image_path = sys.argv[1]
    languages = ["ja", "en"]
    for index, argument in enumerate(sys.argv[2:], 2):
        if argument == "--lang" and index + 1 < len(sys.argv):
            languages = sys.argv[index + 1].split(",")

    import easyocr

    reader = easyocr.Reader(languages, gpu=False, verbose=False)
    output = []
    for bbox, text, confidence in reader.readtext(image_path, detail=1):
        output.append(
            {
                "bbox": [[int(point[0]), int(point[1])] for point in bbox],
                "text": text,
                "conf": round(confidence, 2),
            }
        )
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
