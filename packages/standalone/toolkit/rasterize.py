"""Trusted host helper. Input PDF remains untrusted; caller applies time and OS sandbox limits."""
import json
import pathlib
import sys
import pymupdf

source, output, limit = sys.argv[1], pathlib.Path(sys.argv[2]), int(sys.argv[3])
pages, fonts = [], []
with pymupdf.open(source) as pdf:
    if pdf.is_encrypted:
        raise ValueError("Encrypted PDFs cannot be rendered")
    if not 0 < len(pdf) <= limit:
        raise ValueError(f"Document must contain 1 to {limit} pages")
    for number, page in enumerate(pdf, 1):
        # 144 dpi, bounded before allocating the pixmap.
        if page.rect.width * page.rect.height * 4 > 20_000_000:
            raise ValueError("Page exceeds the 20 megapixel render limit")
        name = f"page-{number:03d}.png"
        page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False).save(output / name)
        pages.append(name)
        fonts.append(sorted({font[3] for font in page.get_fonts(full=True)
                             if font[0] > 0 and pdf.extract_font(font[0])[3]}))
print(json.dumps({"pageCount": len(pages), "pages": pages, "fonts": fonts}))
