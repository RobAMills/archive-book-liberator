# Archive.org → EPUB Pipeline

Complete workflow for converting an Archive.org scanned book (page images) into a properly formatted EPUB, as used for *How to Adjust & Repair Your Sewing Machine* (51 pages).

## Overview

```
Archive.org book reader
   └─ browser-script.js          download page scans (JPGs)
        └─ images/               book_page_NNN.jpg
             └─ src/index.js     images → book.pdf (pdf-lib)
                  └─ ocrmypdf    book.pdf → book_ocr.pdf + book_ocr.txt (tesseract)
                       └─ src/extract_figures.py   per-page OCR text + figure crops
                            └─ build/pages.json + build/figures/
                                 └─ pages_src/pNNN.html   hand-reviewed page fragments
                                      └─ src/make-final-epub.js  → book_final.epub
```

## Step 1 — Download the page scans

Open the book on Archive.org, then run `browser-script.js` in the browser DevTools console.

**Prerequisites (one-time):** Chrome blocks multiple automatic downloads per site. When the
"Allow multiple downloads?" popup appears in the address bar, click **Allow**. (Or pre-allow it:
lock icon → Site settings → Automatic downloads → Allow.)

The script clicks "next page" (or sends arrow keys), grabs each `.BRpageimage` image, renders
it to canvas as a JPEG (~70% quality), and triggers a download, pausing
`DOWNLOAD_DELAY` (1500 ms) between saves so nothing is silently dropped.

**Gotchas:**
- Don't trust a hardcoded page count — count the actual downloaded JPGs.
- Set `START_PAGE`/`END_PAGE` to re-fetch individual missing pages.
- Verify: `ls images/*.jpg | wc -l` and check for gaps in the sequence.

Move results into `images/` as `book_page_001.jpg` … `book_page_NNN.jpg`.

## Step 2 — Build the image PDF

```bash
npm install        # pdf-lib (pure JS; the old images-to-pdf/hummus stack has CVEs)
npm start          # src/index.js: images/*.jpg → book.pdf
```

Each image becomes one page sized to the image. 51 pages ≈ 10 MB, builds in seconds.

## Step 3 — OCR

```bash
brew install ocrmypdf tesseract
ocrmypdf --deskew --optimize 1 --sidecar book_ocr.txt book.pdf book_ocr.pdf
```

- `book_ocr.pdf` — searchable PDF (PDF/A-2b), text layer under each scan
- `book_ocr.txt` — raw text (~0.7 s/page)

## Step 4 — Extract per-page text + figure crops

```bash
python3 src/extract_figures.py
```

Outputs:
- `build/pages.json` — per page: text blocks (with bounding boxes, header flags, reading
  order) and figure references
- `build/figures/fig_pNNN_M.jpg` — cropped diagrams/illustrations

How it works (tuned for noisy grayscale typewriter-era scans):

| Stage | Method |
|---|---|
| Text | tesseract TSV (`--psm 3`), words grouped into paragraphs; spaces rebuilt from x-gaps; hyphenation re-joined |
| Binarization | **Otsu** global threshold (adaptive thresholding fails on noisy scans — treats background as ink) |
| Figures | ink contours after masking out text boxes; filter by size/ink density; merge overlapping boxes |
| Two-column pages | detect vertical whitespace gutter (min of smoothed ink profile in the 35–65% zone, < 50% of body density); OCR each half separately; order left column first |
| Headers | ALL-CAPS majority or short centered lines |

**Known limitation:** figure crops can clip tight to the ink — add bounding-box padding if
diagram edges get cut.

## Step 5 — Hand-review each page (the quality step)

Automatic reconstruction of old scans is never clean enough. For each page:

1. **Look at the original scan** (`images/book_page_NNN.jpg`) — alongside the OCR text and
   figure crops from `build/pages.json`.
2. Write `pages_src/pNNN.html` — a body-only fragment:
   - correct OCR misreads (typewriter fonts: "4s"→"is", "apring"→"spring", column bleed)
   - rebuild tables as real `<table>` markup
   - restore numbered/bulleted list structure
   - place figure crops with `<figure><img src="images/fig_pNNN_M.jpg"/><figcaption>…</figcaption></figure>`
   - use `<h1>/<h2>` for headings, `<p class="small">` for notes
3. Pages are grouped 10 per chapter file at build time; the first `<h1>` becomes the
   chapter/TOC title.

## Step 6 — Assemble the EPUB

```bash
node src/make-final-epub.js    # → book_final.epub, then: open book_final.epub
```

The builder:
- wraps each 10-page group in valid XHTML (chapter files in `OEBPS/text/`)
- rewrites `src="images/…"` → `src="../images/…"` (relative paths from `text/`)
- copies only referenced figures into `OEBPS/images/`
- emits `mimetype` (stored, uncompressed, first entry), `META-INF/container.xml`,
  `content.opf` manifest/spine, and `nav.xhtml` TOC
- validates the zip structure

**Path lesson learned:** images packaged correctly but referenced from a different
directory = "broken images" that Books still opens. Verify image paths resolve from the
XHTML location.

## Verification checklist

```bash
# structure
unzip -l book_final.epub | head            # mimetype must be first, size 20
# no missing images
grep -ho 'images/[^"]*' pages_src/*.html | sort -u | while read f; do
  [ -f "build/$f" ] || echo "MISSING $f"; done
# all referenced figures present in the epub
unzip -l book_final.epub | grep -c image/jpeg
```

Then open in Books (or any reader) and spot-check:
- [ ] every figure renders (no broken-image placeholders)
- [ ] tables read correctly row by row
- [ ] two-column pages read left column, then right
- [ ] page numbers / TOC cross-references still make sense

## Outputs

| File | Size | Purpose |
|---|---|---|
| `book.pdf` | ~10 MB | image-only PDF |
| `book_ocr.pdf` | ~9 MB | searchable PDF (PDF/A-2b) |
| `book.epub` | ~10 MB | hybrid: full scans + OCR text (fallback reference) |
| `book_final.epub` | ~2 MB | **final: clean text + figure crops** |
