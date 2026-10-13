#!/usr/bin/env python3
"""Independent, read-only oracle for the generated workflow qualification PDFs."""
import json
import sys

import pypdf
from pypdf import PdfReader


def inspect(filename):
    reader = PdfReader(filename, strict=True)
    return {
        "engine": "pypdf",
        "version": pypdf.__version__,
        "pages": [
            {"text": page.extract_text(), "rotation": page.rotation,
             "width": float(page.mediabox.width), "height": float(page.mediabox.height)}
            for page in reader.pages
        ],
        "fields": {name: str(field.get("/V", ""))
                   for name, field in (reader.get_fields() or {}).items()},
    }


if __name__ == "__main__":
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
