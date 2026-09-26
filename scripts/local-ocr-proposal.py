#!/usr/bin/env python3
"""Experimental, opt-in macOS OCR proposal for one PDF page.

This is not registered as an MCP tool and is not included in either package.
It retains the rendered image and labels recognized text as an unverified
proposal. It never edits the PDF or substitutes OCR for its text layer.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import re
import stat


SCHEMA = "pdf-tools.local-ocr-proposal.v0"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_PNG_BYTES = 25 * 1024 * 1024
MAX_IMAGE_PIXELS = 25_000_000
MAX_OBSERVATIONS = 1_000
MAX_TEXT_CHARS = 500
RENDER_SCALE = 2


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def read_source(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size < 1 or before.st_size > MAX_PDF_BYTES:
            raise ValueError("source must be a bounded regular PDF file")
        data = bytearray()
        while len(data) <= MAX_PDF_BYTES:
            block = os.read(fd, min(1024 * 1024, MAX_PDF_BYTES + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        after = os.fstat(fd)
        current = os.lstat(path)
        if (len(data) != before.st_size or len(data) > MAX_PDF_BYTES
                or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                or (after.st_dev, after.st_ino) != (current.st_dev, current.st_ino)):
            raise ValueError("source changed while it was read")
        return bytes(data)
    finally:
        os.close(fd)


def proposal_from_observations(source: bytes, page_number: int, page_count: int,
                               png: bytes, width: int, height: int,
                               observations: list[tuple], engine: dict) -> dict:
    if not source.startswith(b"%PDF-"):
        raise ValueError("source is not a PDF")
    if not isinstance(page_number, int) or not 1 <= page_number <= page_count:
        raise ValueError("page is outside the PDF")
    if not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1:
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
        "limitations": [
            "OCR text is a proposal, not verified PDF text or a replacement for the source text layer.",
            "Engine confidence is an uncalibrated observation, not a correctness probability.",
            "The PNG is retained separately so every proposed box can be visually checked.",
        ],
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--page", type=int, required=True)
    parser.add_argument("--expect-source-sha256", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if not SHA256.fullmatch(args.expect_source_sha256):
        parser.error("expected source digest must be lowercase SHA-256")
    source = read_source(args.pdf)
    if digest(source) != args.expect_source_sha256:
        raise ValueError("source PDF digest does not match the caller's pin")

    # Optional dependencies are imported only after explicit invocation and
    # source verification. Nothing is added to the default PDF Tools package.
    import pypdfium2 as pdfium
    from ocrmac.ocrmac import text_from_image

    document = pdfium.PdfDocument(source)
    page_count = len(document)
    if not 1 <= args.page <= page_count:
        raise ValueError("page is outside the PDF")
    page = document.get_page(args.page - 1)
    width = math.ceil(page.get_width() * RENDER_SCALE)
    height = math.ceil(page.get_height() * RENDER_SCALE)
    if width * height > MAX_IMAGE_PIXELS:
        raise ValueError("render pixel ceiling exceeded")
    image = page.render(scale=RENDER_SCALE).to_pil()
    width, height = image.size
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    png = buffer.getvalue()
    observations = text_from_image(image, recognition_level="accurate", detail=True)
    engine = {
        "name": "ocrmac-vision",
        "ocrmac_version": importlib.metadata.version("ocrmac"),
        "pypdfium2_version": importlib.metadata.version("pypdfium2"),
    }
    proposal = proposal_from_observations(source, args.page, page_count, png,
                                          width, height, observations, engine)

    os.mkdir(args.output_dir, 0o700)
    write_exclusive(args.output_dir / "render.png", png)
    write_exclusive(args.output_dir / "proposal.json", canonical(proposal) + b"\n")
    print(json.dumps({"status": proposal["status"],
                      "proposal_sha256": proposal["proposal_sha256"],
                      "source_pdf_sha256": proposal["source_pdf_sha256"],
                      "render_png_sha256": proposal["render_png_sha256"],
                      "output_dir": str(args.output_dir)}, sort_keys=True))


if __name__ == "__main__":
    main()
