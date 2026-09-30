#!/usr/bin/env python3
"""Extract figures (non-text regions) from scanned pages and build structured
page data: interleaved text blocks and figure crops in reading order."""
import cv2, json, os, subprocess, sys
from pathlib import Path

IMG_DIR = Path("images")
OUT_DIR = Path("build/figures")
DATA = Path("build/pages.json")
TESS = "/opt/homebrew/bin/tesseract"

def ocr_blocks_img(img, x_off=0):
    """OCR an in-memory image; return text blocks with boxes offset by x_off."""
    import numpy as np, tempfile
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        cv2.imwrite(f.name, img)
        tmp = f.name
    r = subprocess.run([TESS, tmp, "-", "--psm", "3", "tsv"],
                       capture_output=True, text=True)
    os.unlink(tmp)
    blocks = _parse_tsv(r.stdout)
    for b in blocks:
        b["box"][0] += x_off; b["box"][2] += x_off
    return blocks


def _parse_tsv(tsv):
    """Parse tesseract TSV into paragraph blocks with boxes."""
    # word rows carry text; group into paragraphs (block, par), rebuild spacing
    paras = {}  # (block, par) -> [(line_key, [(x, x2, top, h, word)])]
    for row in tsv.splitlines()[1:]:
        p = row.split("\t")
        if len(p) < 12 or p[0] != "5":
            continue
        conf = float(p[10])
        if conf < 25 or not p[11].strip():
            continue
        left, top, w, h = int(p[6]), int(p[7]), int(p[8]), int(p[9])
        pkey = (int(p[2]), int(p[3]))
        lkey = int(p[4])
        paras.setdefault(pkey, {}).setdefault(lkey, []).append((left, left + w, top, h, p[11]))
    out = []
    for pkey, lines in paras.items():
        all_words = []
        seg_lines = []
        for lkey in sorted(lines):
            words = sorted(lines[lkey], key=lambda t: t[0])
            seg_lines.append(words)
            all_words.extend(words)
        x0 = min(w[0] for w in all_words); y0 = min(w[2] for w in all_words)
        x1 = max(w[1] for w in all_words); y1 = max(w[2] + w[3] for w in all_words)
        avg_h = sum(w[3] for w in all_words) / len(all_words)
        # join lines into one paragraph, handling hyphenation
        parts = []
        for li, words in enumerate(seg_lines):
            line_text, prev_x2 = [], None
            for x, x2, top, h, text in words:
                if prev_x2 is not None and x - prev_x2 > 0.3 * avg_h:
                    line_text.append(" ")
                line_text.append(text)
                prev_x2 = x2
            parts.append("".join(line_text).strip())
        # merge: hyphen at line end joins; otherwise single space
        merged = parts[0]
        for nxt in parts[1:]:
            if merged.endswith("-"):
                merged = merged[:-1] + nxt
            else:
                merged += " " + nxt
        out.append({"text": merged.strip(), "box": [x0, y0, x1, y1]})
    return out

def find_figures(img_path, text_boxes):
    """Detect ink regions not covered by text -> figure crops."""
    img = cv2.imread(str(img_path))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    H, W = gray.shape
    binv = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    # Mask out text blocks (padded)
    mask = binv.copy()
    for x, y, x2, y2 in text_boxes:
        cv2.rectangle(mask, (max(0, x - 10), max(0, y - 10)),
                      (min(W, x2 + 10), min(H, y2 + 10)), 0, -1)
    # Close small gaps to merge figure parts
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    figs = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        area = w * h
        if area < 0.004 * W * H:      # too small
            continue
        if w < 0.05 * W or h < 0.04 * H:
            continue
        # Must be mostly non-text ink
        roi = mask[y:y + h, x:x + w]
        if cv2.countNonZero(roi) < 0.01 * area:
            continue
        figs.append([x, y, x + w, y + h])
    # Merge overlapping/nearby figure boxes
    figs.sort(key=lambda b: b[1])
    merged = []
    for f in figs:
        if merged and overlaps(merged[-1], f, W, H):
            merged[-1] = union(merged[-1], f)
        else:
            merged.append(f)
    return img, merged

def overlaps(a, b, W, H, pad=15):
    return not (a[2] + pad < b[0] or b[2] + pad < a[0] or
                a[3] + pad < b[1] or b[3] + pad < a[1])

def union(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]

def crop_save(img, box, name):
    x, y, x2, y2 = box
    pad = 8
    crop = img[max(0, y - pad):y2 + pad, max(0, x - pad):x2 + pad]
    cv2.imwrite(str(OUT_DIR / name), crop,
                [cv2.IMWRITE_JPEG_QUALITY, 85])

def detect_two_column(img, text_boxes):
    """Find a vertical whitespace gap near mid-page separating two text columns."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    H, W = bw.shape
    col_ink = cv2.reduce(bw, 0, cv2.REDUCE_SUM, dtype=cv2.CV_32F).ravel() / 255
    # smooth
    k = 21
    col_ink = cv2.blur(col_ink.reshape(1, -1), (1, k)).ravel()
    typ = col_ink[int(0.05*W):int(0.35*W)].mean()
    lo, hi = int(0.35 * W), int(0.65 * W)
    zone = col_ink[lo:hi]
    xmin = lo + int(zone.argmin())
    # accept if the gutter is substantially emptier than body columns
    left_typ = col_ink[int(0.05*W):lo].mean()
    right_typ = col_ink[hi:int(0.95*W)].mean() if hi < int(0.95*W) else typ
    typ = min(left_typ, right_typ)
    return xmin if col_ink[xmin] < 0.5 * typ else None


def columnar_order_and_merge(items, shape, gap=None):
    """Order left column fully before right (gap = detected gutter x).
    Merge vertically-adjacent short label fragments."""
    H, W = shape[:2]
    text_items = [it for it in items if it["type"] == "text"]
    two_col = gap is not None

    def col(it):
        if not two_col:
            return 0
        return 0 if it["box"][0] < gap else 1

    # figures keep their position relative to their column's text flow
    items.sort(key=lambda it: (col(it) if it["type"] == "text" else col_fig(it, gap),
                               it["top"]) if two_col else (0, it["top"]))

    # Merge short label fragments stacked vertically in same column
    if two_col:
        merged = []
        for it in items:
            if (it["type"] == "text" and merged and
                    merged[-1]["type"] == "text" and
                    col(merged[-1]) == col(it) and
                    0 <= it["top"] - merged[-1]["box"][3] < 40 and
                    len(merged[-1]["text"].split()) <= 4 and
                    len(it["text"].split()) <= 4 and
                    abs(merged[-1]["box"][0] - it["box"][0]) < 40):
                # join stacked label words: "The Upper" + "Thread Breaks"
                merged[-1]["text"] += " " + it["text"]
                merged[-1]["box"][3] = it["box"][3]
                merged[-1]["header"] = False
            else:
                merged.append(it)
        items = merged
    return items


def col_fig(it, gap):
    cx = (it["box"][0] + it["box"][2]) / 2
    return 0 if cx < gap else 1


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    images = sorted(p for p in IMG_DIR.glob("*.jpg"))
    pages = []
    for i, img_path in enumerate(images):
        pageno = i + 1
        img = cv2.imread(str(img_path))
        gap = detect_two_column(img, [])
        if gap:
            H, W = img.shape[:2]
            left_img = img[:, :gap]
            right_img = img[:, gap:]
            lblocks = ocr_blocks_img(left_img, 0)
            rblocks = ocr_blocks_img(right_img, gap - 10)
            blocks = lblocks + rblocks
        else:
            blocks = ocr_blocks_img(img, 0)
        blocks = [b for b in blocks if len(b["text"]) > 2]
        img_, figs = find_figures(img_path, [b["box"] for b in blocks])
        # Headers are ALL-CAPS or short centered lines - not sentence fragments
        items = []
        imgW = img.shape[1]
        for b in blocks:
            x, y, x2, y2 = b["box"]
            h = y2 - y
            t = b["text"]
            words = t.split()
            letters = [c for c in t if c.isalpha()]
            is_caps = bool(letters) and sum(c.isupper() for c in letters) / len(letters) > 0.8
            is_centered = abs((x + x2) / 2 - imgW / 2) < 0.08 * imgW
            items.append({"type": "text", "text": t, "top": y, "box": b["box"],
                          "header": is_caps or (is_centered and len(words) <= 8 and h < 60)})
        for j, box in enumerate(figs):
            fname = f"fig_p{pageno:03d}_{j + 1}.jpg"
            crop_save(img, box, fname)
            w, h = box[2] - box[0], box[3] - box[1]
            items.append({"type": "figure", "src": fname, "top": box[1],
                          "box": box, "w": w, "h": h})
        # Column-aware ordering + fragment merging
        items = columnar_order_and_merge(items, img.shape, gap)
        pages.append({"page": pageno, "items": items})
        print(f"page {pageno}: {len(blocks)} text blocks, {len(figs)} figures")
    DATA.write_text(json.dumps(pages, indent=1))
    print(f"wrote {DATA}")

if __name__ == "__main__":
    main()
