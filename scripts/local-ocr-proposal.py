#!/usr/bin/env python3
"""Experimental, opt-in macOS OCR proposal for one PDF page.

This is not registered as an MCP tool and is not included in either package.
It retains the rendered image and labels recognized text as an unverified
proposal. It never edits the PDF or substitutes OCR for its text layer.
"""

from __future__ import annotations

import argparse
import base64
from decimal import Decimal
import html
import hashlib
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import re
import stat
import sys


SCHEMA = "pdf-tools.local-ocr-proposal.v1"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_PNG_BYTES = 25 * 1024 * 1024
MAX_IMAGE_PIXELS = 25_000_000
MAX_OBSERVATIONS = 1_000
MAX_TEXT_CHARS = 500
RENDER_SCALE = 2
MAX_PROPOSAL_BYTES = 4 * 1024 * 1024
LIMITATIONS = [
    "OCR text is a proposal, not verified PDF text or a replacement for the source text layer.",
    "Engine confidence is an uncalibrated observation, not a correctness probability.",
    "The PNG is retained separately so every proposed box can be visually checked.",
]


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def read_regular(path: Path, ceiling: int, private: bool = False) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(path, flags)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size < 1 or before.st_size > ceiling:
            raise ValueError("input must be a bounded regular file")
        if private and stat.S_IMODE(before.st_mode) != 0o600:
            raise ValueError("retained file must have mode 0600")
        data = bytearray()
        while len(data) <= ceiling:
            block = os.read(fd, min(1024 * 1024, ceiling + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        after = os.fstat(fd)
        current = os.lstat(path)
        if (len(data) != before.st_size or len(data) > ceiling
                or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                or (after.st_dev, after.st_ino) != (current.st_dev, current.st_ino)):
            raise ValueError("input changed while it was read")
        return bytes(data)
    finally:
        os.close(fd)


def read_source(path: Path) -> bytes:
    data = read_regular(path, MAX_PDF_BYTES)
    if not data.startswith(b"%PDF-"):
        raise ValueError("source is not a PDF")
    return data


def strict_json(data: bytes) -> dict:
    def members(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON member")
            result[key] = value
        return result

    def reject_constant(value):
        raise ValueError("nonfinite JSON value")

    result = json.loads(data, object_pairs_hook=members, parse_constant=reject_constant)
    if not isinstance(result, dict):
        raise ValueError("retained JSON must be an object")
    if canonical(result) + b"\n" != data:
        raise ValueError("retained JSON must use exact canonical bytes")
    return result


def proposal_from_observations(source: bytes, page_number: int, page_count: int,
                               png: bytes, width: int, height: int,
                               observations: list[tuple], engine: dict) -> dict:
    if not source.startswith(b"%PDF-"):
        raise ValueError("source is not a PDF")
    if type(page_count) is not int or type(page_number) is not int or not 1 <= page_number <= page_count:
        raise ValueError("page is outside the PDF")
    if type(width) is not int or type(height) is not int or width < 1 or height < 1:
        raise ValueError("render dimensions are invalid")
    if width * height > MAX_IMAGE_PIXELS or not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) > MAX_PNG_BYTES:
        raise ValueError("render is not a bounded PNG")
    if len(observations) > MAX_OBSERVATIONS:
        raise ValueError("OCR observation ceiling exceeded")

    proposals = []
    for index, observation in enumerate(observations):
        if not isinstance(observation, (tuple, list)) or len(observation) != 3:
            raise ValueError("OCR observation shape is invalid")
        text, confidence, box = observation
        if not isinstance(text, str) or not text or len(text) > MAX_TEXT_CHARS:
            raise ValueError("OCR text is empty or too long")
        if type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError("OCR engine confidence is invalid")
        if not isinstance(box, (tuple, list)) or len(box) != 4:
            raise ValueError("OCR bounding box is invalid")
        if any(type(v) not in (int, float) or not math.isfinite(v) for v in box):
            raise ValueError("OCR bounding box is not finite")
        x, y, w, h = box  # Vision coordinates: normalized, bottom-left origin.
        if min(x, y, w, h) < 0 or w <= 0 or h <= 0 or x + w > 1 or y + h > 1:
            raise ValueError("OCR bounding box is outside the rendered page")
        proposals.append({
            "observation_index": index,
            "text_proposal": text,
            "engine_confidence_unverified": round(float(confidence), 6),
            "box_top_left_pixels": [round(x * width, 2), round((1 - y - h) * height, 2),
                                    round(w * width, 2), round(h * height, 2)],
        })

    body = {
        "schema": SCHEMA,
        "status": "unverified_ocr_proposal",
        "source_pdf_sha256": digest(source),
        "source_pdf_bytes": len(source),
        "page_number": page_number,
        "page_count": page_count,
        "render_png_sha256": digest(png),
        "render_png_bytes": len(png),
        "render_width_pixels": width,
        "render_height_pixels": height,
        "render_scale": RENDER_SCALE,
        "engine": engine,
        "proposals": proposals,
        "limitations": LIMITATIONS,
    }
    return {**body, "proposal_sha256": digest(canonical(body))}


def write_exclusive(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def retain_proposal(folder: Path, png: bytes, proposal: dict) -> None:
    # commit.json is written last. Any interrupted prefix is explicitly
    # incomplete and cannot be read as a committed proposal. Never overwrite it.
    # macOS /tmp and user-selected shortcut parents may be symlinks. Resolve
    # the existing parent before writing so its final no-follow fsync uses the
    # same physical directory. The new final component remains exclusive.
    folder = folder.parent.resolve(strict=True) / folder.name
    os.mkdir(folder, 0o700)
    proposal_bytes = canonical(proposal) + b"\n"
    write_exclusive(folder / "render.png", png)
    write_exclusive(folder / "proposal.json", proposal_bytes)
    sync_directory(folder)
    commit = {
        "schema": "pdf-tools.local-ocr-commit.v1",
        "proposal_sha256": proposal["proposal_sha256"],
        "proposal_file_sha256": digest(proposal_bytes),
        "render_png_sha256": digest(png),
    }
    write_exclusive(folder / "commit.json", canonical(commit) + b"\n")
    sync_directory(folder)
    sync_directory(folder.parent)


def review_html_document(body: dict, png: bytes, proposal_sha: str) -> bytes:
    """Offline display of an already validated snapshot; never approves words."""
    css = """
*{box-sizing:border-box}body{margin:0;background:#f4f3ef;color:#202522;font:15px system-ui,sans-serif}
header{padding:26px 36px 20px;border-bottom:1px solid #d7dad3;background:#fff}
.brand{font-size:12px;font-weight:700;letter-spacing:.12em;color:#497063;text-transform:uppercase}
h1{font-size:28px;letter-spacing:-.03em;margin:7px 0}p{margin:8px 0;line-height:1.5}
.status{font-size:14px;color:#425549}.warning{color:#594720;font-weight:600}
main{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,1fr);gap:28px;padding:24px 36px}
h2{font-size:16px;margin:0 0 12px}.page{max-height:calc(100vh - 224px);overflow:auto;border:1px solid #d7dad3;background:white}
svg{display:block;width:100%;height:auto}.box{fill:transparent;stroke:transparent;stroke-width:2;transition:fill .12s,stroke .12s}
.box:target{stroke:#207957;fill:#20795722;stroke-width:3}
ol{list-style:none;padding:0;margin:0;max-height:calc(100vh - 280px);overflow:auto}
li{border-top:1px solid #d7dad3}li:first-child{border-top:0}
a{display:grid;grid-template-columns:32px minmax(0,1fr);gap:10px;padding:12px 8px;color:inherit;text-decoration:none;transition:background .12s}
a:hover{background:#e9eae6}a:focus-visible{outline:2px solid #207957;outline-offset:-2px}
.number{color:#647368;font-size:12px;padding-top:2px}.words{white-space:pre-wrap;overflow-wrap:anywhere}
small{display:block;font-size:11px;color:#667169;margin-top:5px}.hint{font-size:13px;color:#58665c}
details{margin-top:16px;border-top:1px solid #d7dad3;padding-top:12px}summary{cursor:pointer;font-size:13px}
code{font-size:11px;overflow-wrap:anywhere}footer{padding:0 36px 24px;font-size:12px;color:#667169}
@media(max-width:850px){header{padding:20px}main{grid-template-columns:1fr;padding:20px;gap:22px}.page{max-height:65vh}ol{max-height:55vh}footer{padding:0 20px 20px}}
@media(prefers-reduced-motion:reduce){a,.box{transition:none}}
"""
    # Keep the selected text in step with the source box without scripting.
    css += "\n".join(f'body:has(#box-{index}:target) a[href="#box-{index}"]'
                     '{background:#e6ede7;box-shadow:inset 3px 0 #207957}'
                     for index in range(len(body["proposals"])))
    style_hash = base64.b64encode(hashlib.sha256(css.encode()).digest()).decode()
    image = base64.b64encode(png).decode()
    boxes, rows = [], []
    for index, item in enumerate(body["proposals"]):
        text = html.escape(item["text_proposal"], quote=True)
        x, y, w, h = item["box_top_left_pixels"]
        boxes.append(f'<rect class="box" id="box-{index}" x="{x}" y="{y}" '
                     f'width="{w}" height="{h}"><title>{index + 1}: {text}</title></rect>')
        score = item["engine_confidence_unverified"]
        rows.append(f'<li><a href="#box-{index}"><span class="number">{index + 1}</span>'
                    f'<span class="words">{text}<small>Engine score {score:.6f}; uncalibrated</small>'
                    '</span></a></li>')
    width, height = body["render_width_pixels"], body["render_height_pixels"]
    count = len(rows)
    empty = '<p>No text was proposed for this page.</p>' if not rows else ''
    document = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'sha256-{style_hash}'; base-uri 'none'; form-action 'none'">
<title>Review OCR proposals | PDF Tools</title><style>{css}</style></head>
<body><header><div class="brand">PDF Tools · Local review</div><h1>Review OCR proposals</h1>
<p class="status">Page {body["page_number"]} of {body["page_count"]} · {count} proposed text observations · source image replay matched</p>
<p class="warning">Words may be wrong. Check them against the scan before using them.</p></header>
<main><section aria-labelledby="source-heading"><h2 id="source-heading">Original page</h2>
<div class="page"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="Original PDF page with proposed text boxes">
<image href="data:image/png;base64,{image}" width="{width}" height="{height}"/>{''.join(boxes)}</svg></div></section>
<section aria-labelledby="proposal-heading"><h2 id="proposal-heading">Proposed text, not verified</h2>
<p class="hint">Select text to highlight its box on the page. Use your browser's Find to locate a word.</p>
{empty}<ol aria-label="OCR observations">{''.join(rows)}</ol><details><summary>Source and proposal identity</summary>
<p>PDF SHA-256<br><code>{body["source_pdf_sha256"]}</code></p><p>Proposal SHA-256<br><code>{proposal_sha}</code></p>
<p>Rendered page SHA-256<br><code>{body["render_png_sha256"]}</code></p></details></section></main>
<footer>Offline, read-only snapshot. No uploads, analytics, corrections, approval or changes to the PDF. Image replay does not verify OCR words.</footer>
</body></html>'''
    return document.encode("utf-8")


def verify_retained(folder: Path, source: bytes, expected_proposal: str, render,
                    review_html: Path | None = None) -> dict:
    if not SHA256.fullmatch(expected_proposal):
        raise ValueError("expected proposal digest must be lowercase SHA-256")
    info = os.lstat(folder)
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("proposal directory must be physical and mode 0700")
    if set(os.listdir(folder)) != {"render.png", "proposal.json", "commit.json"}:
        raise ValueError("proposal is incomplete or has unexpected files")
    commit = strict_json(read_regular(folder / "commit.json", 2048, private=True))
    proposal_bytes = read_regular(folder / "proposal.json", MAX_PROPOSAL_BYTES, private=True)
    proposal = strict_json(proposal_bytes)
    png = read_regular(folder / "render.png", MAX_PNG_BYTES, private=True)
    expected_commit = {
        "schema": "pdf-tools.local-ocr-commit.v1",
        "proposal_sha256": expected_proposal,
        "proposal_file_sha256": digest(proposal_bytes),
        "render_png_sha256": digest(png),
    }
    if commit != expected_commit:
        raise ValueError("retained files do not match the commit and caller pin")
    body = {key: value for key, value in proposal.items() if key != "proposal_sha256"}
    if proposal.get("proposal_sha256") != expected_proposal or digest(canonical(body)) != expected_proposal:
        raise ValueError("proposal digest does not match its body")
    expected_keys = {"schema", "status", "source_pdf_sha256", "source_pdf_bytes", "page_number",
                     "page_count", "render_png_sha256", "render_png_bytes", "render_width_pixels",
                     "render_height_pixels", "render_scale", "engine", "proposals", "limitations"}
    if set(body) != expected_keys or body["schema"] != SCHEMA or body["status"] != "unverified_ocr_proposal":
        raise ValueError("unsupported proposal schema or fields")
    if (body["source_pdf_sha256"] != digest(source) or type(body["source_pdf_bytes"]) is not int
            or body["source_pdf_bytes"] != len(source) or body["limitations"] != LIMITATIONS
            or type(body["render_scale"]) is not int or body["render_scale"] != RENDER_SCALE):
        raise ValueError("proposal source or policy does not match")
    if type(body["page_number"]) is not int or type(body["page_count"]) is not int:
        raise ValueError("proposal page identity is invalid")
    if not 1 <= body["page_number"] <= body["page_count"]:
        raise ValueError("proposal page is outside the PDF")
    replay_png, width, height, page_count, renderer = render(source, body["page_number"])
    engine = body["engine"]
    if (not isinstance(engine, dict)
            or set(engine) != {"name", "ocrmac_version", "pypdfium2_version", "pillow_version"}
            or engine["name"] != "ocrmac-vision"
            or any(not isinstance(value, str) or not value or len(value) > 100 for value in engine.values())
            or any(engine.get(key) != value for key, value in renderer.items())):
        raise ValueError("proposal renderer identity does not match")
    if (png != replay_png or body["render_png_sha256"] != digest(png)
            or type(body["render_png_bytes"]) is not int or body["render_png_bytes"] != len(png)
            or type(body["render_width_pixels"]) is not int or body["render_width_pixels"] != width
            or type(body["render_height_pixels"]) is not int or body["render_height_pixels"] != height
            or body["page_count"] != page_count):
        raise ValueError("retained render does not replay from the exact source page")
    observations = body["proposals"]
    if not isinstance(observations, list) or len(observations) > MAX_OBSERVATIONS:
        raise ValueError("proposal observations are invalid")
    for index, item in enumerate(observations):
        if not isinstance(item, dict) or set(item) != {
                "observation_index", "text_proposal", "engine_confidence_unverified", "box_top_left_pixels"}:
            raise ValueError("proposal observation fields are invalid")
        text, confidence, box = item["text_proposal"], item["engine_confidence_unverified"], item["box_top_left_pixels"]
        if (type(item["observation_index"]) is not int or item["observation_index"] != index
                or not isinstance(text, str) or not text or len(text) > MAX_TEXT_CHARS
                or type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 <= confidence <= 1
                or not isinstance(box, list) or len(box) != 4
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in box)):
            raise ValueError("proposal observation values are invalid")
        x, y, w, h = box
        # Coordinates were independently rounded to 0.01 pixels. Decimal
        # sums preserve that allowance without binary float edge overflow.
        right = Decimal(str(x)) + Decimal(str(w))
        bottom = Decimal(str(y)) + Decimal(str(h))
        if (min(x, y, w, h) < 0 or right > Decimal(width) + Decimal("0.01")
                or bottom > Decimal(height) + Decimal("0.01")):
            raise ValueError("proposal box is outside the rendered page")
    result = {"status": "source_render_replayed_ocr_unverified", "proposal_sha256": expected_proposal,
              "source_pdf_sha256": digest(source), "render_png_sha256": digest(png),
              "page_number": body["page_number"], "observation_count": len(observations)}
    if review_html is not None:
        # Build from the same in-memory bytes just validated, not a second
        # pathname read that could display a different proposal or image.
        output = review_html.parent.resolve(strict=True) / review_html.name
        if output.parent == folder.resolve(strict=True):
            raise ValueError("review HTML must be outside the retained proposal directory")
        document = review_html_document(body, png, expected_proposal)
        write_exclusive(output, document)
        sync_directory(output.parent)
        result["review_html_sha256"] = digest(document)
    return result


def render_page(source: bytes, page_number: int):
    try:
        import pypdfium2 as pdfium
        import PIL  # Also required by the optional renderer.
    except ImportError as error:
        raise RuntimeError("Optional renderer unavailable; install pypdfium2 and Pillow in a separate environment") from error
    renderer = {"pypdfium2_version": importlib.metadata.version("pypdfium2"),
                "pillow_version": PIL.__version__}
    document = pdfium.PdfDocument(source)
    try:
        page_count = len(document)
        if not 1 <= page_number <= page_count:
            raise ValueError("page is outside the PDF")
        page = document.get_page(page_number - 1)
        try:
            width = math.ceil(page.get_width() * RENDER_SCALE)
            height = math.ceil(page.get_height() * RENDER_SCALE)
            if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("render pixel ceiling exceeded")
            bitmap = page.render(scale=RENDER_SCALE)
            try:
                image = bitmap.to_pil()
                try:
                    buffer = io.BytesIO()
                    image.save(buffer, format="PNG")
                    png = buffer.getvalue()
                    width, height = image.size
                finally:
                    image.close()
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        document.close()
    if len(png) > MAX_PNG_BYTES:
        raise ValueError("render PNG ceiling exceeded")
    return png, width, height, page_count, renderer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--page", type=int)
    parser.add_argument("--expect-source-sha256", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output-dir", type=Path)
    mode.add_argument("--verify-proposal-dir", type=Path)
    parser.add_argument("--expect-proposal-sha256")
    parser.add_argument("--review-html", type=Path,
                        help="Write a new offline read-only HTML review after successful replay")
    args = parser.parse_args()
    if args.review_html and not args.verify_proposal_dir:
        parser.error("--review-html requires --verify-proposal-dir")
    if not SHA256.fullmatch(args.expect_source_sha256):
        parser.error("expected source digest must be lowercase SHA-256")
    source = read_source(args.pdf)
    if digest(source) != args.expect_source_sha256:
        raise ValueError("source PDF digest does not match the caller's pin")

    if args.verify_proposal_dir:
        if args.page is not None or not args.expect_proposal_sha256:
            parser.error("verification requires a proposal digest and uses the retained page number")
        print(json.dumps(verify_retained(args.verify_proposal_dir, source,
                                        args.expect_proposal_sha256, render_page,
                                        review_html=args.review_html), sort_keys=True))
        return
    if args.page is None or args.expect_proposal_sha256 is not None:
        parser.error("generation requires --page and no proposal digest")
    if sys.platform != "darwin":
        raise RuntimeError("Optional OCR adapter requires macOS Vision; no OCR output was created")

    # Optional dependencies are imported only after explicit invocation and
    # source verification. Nothing is added to the default PDF Tools package.
    try:
        from ocrmac.ocrmac import text_from_image
        from PIL import Image
    except ImportError as error:
        raise RuntimeError("Optional OCR adapter unavailable; install ocrmac, pypdfium2 and Pillow in a separate environment") from error
    png, width, height, page_count, renderer = render_page(source, args.page)
    with Image.open(io.BytesIO(png)) as image:
        observations = text_from_image(image, recognition_level="accurate", detail=True)
    engine = {
        "name": "ocrmac-vision",
        "ocrmac_version": importlib.metadata.version("ocrmac"),
        **renderer,
    }
    proposal = proposal_from_observations(source, args.page, page_count, png,
                                          width, height, observations, engine)

    retain_proposal(args.output_dir, png, proposal)
    print(json.dumps({"status": proposal["status"],
                      "proposal_sha256": proposal["proposal_sha256"],
                      "source_pdf_sha256": proposal["source_pdf_sha256"],
                      "render_png_sha256": proposal["render_png_sha256"],
                      "output_dir": str(args.output_dir)}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(json.dumps({"status": "ocr_proposal_failed", "message": str(error)}, sort_keys=True), file=sys.stderr)
        sys.exit(2)
