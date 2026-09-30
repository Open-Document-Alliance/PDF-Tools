# Experimental opt-in local OCR proposal, Apollo page

This is a private development result, not a shipped OCR feature, complete
transcription, benchmark, or claim that the PDF text layer is correct.

## Boundary and result

The experimental `scripts/local-ocr-proposal.py` reads a caller-pinned PDF,
renders one page locally through separately installed pypdfium2, and asks
macOS Vision through separately installed ocrmac for text observations. It
retains the exact rendered PNG and a digest-bound JSON proposal in a new
private output directory. It does not edit the PDF, replace its text layer,
register an MCP tool, or add an OCR dependency to either product package.

On the one-page National Archives Apollo flight-plan regression, the proposal
contains 119 OCR observations. Concatenated observation text contains all 8/8
previously frozen literal visible anchors. This is a presence check only:
observation order does not reconstruct the chart, and other words are wrong
(for example, `FLIGIM` where the page shows `FLIGHT`). The engine's numeric
confidence is retained only as an uncalibrated observation. The proposal is
not source-verified text and cannot silently fill a verified extraction field.

## Exact run

- Host: MSS MacBook, macOS arm64, local execution with no provider call.
- Source: `apollo-11-flight-plan.pdf`, SHA-256
  `539cc6aeaf44e5f3a9919ebbe6416654fac1b784feb5e30b868bd8af83b0e22b`.
- Page: 1 of 1; render 1584 by 1224 pixels at scale 2.
- Optional engines: ocrmac 1.0.1 and pypdfium2 5.13.0.
- Prototype script SHA-256:
  `fc6fd1306eb378ab915300e7d3548c37f71585c6e1d95a23b75ea6053d39d5fb`.
- Exact final-script private output:
  `~/Library/Caches/oda-pdf-tools-extraction/ocr-proposal-apollo-20260926-v1/`.
- Retained PNG: 2,351,721 bytes, SHA-256
  `1e7e17ea7cb2efbeff08069e75891fdcf959d1ef9f091151c5260779322d31c6`.
- Retained proposal file: 17,581 bytes, SHA-256
  `8d52bc05bb2a83e4465a2fb9ab6df103f5ca20acf369398d8d1d7bf4c283807d`.
- Embedded proposal-body digest:
  `6a6640bea52cdf96ff6d50426edae4fed24bebe66b9a11a4a3a1d447759a483f`.
- Output directory mode 0700; both files mode 0600.

A preceding run before a stricter boolean-input validation change yielded
byte-identical PNG and proposal files. The validation change does not affect
the actual Vision observations. A wrong pinned source digest failed before
OCR or output-directory creation.
The dependency-free contract unit suite passed 5/5 on Linux. The reviewed
September 22 Docling comparison remains the baseline: the default PDF Tools
path returned explicit no-OCR gaps and 0/8 visible scan anchors in Markdown;
Docling's optional OCR found 7/8 in structured output but 0/8 in Markdown.
This new 8/8 presence result is not a fair overall quality ranking because
the pipelines expose different output surfaces and no full-page ground truth
or reading-order score was applied here.

## Next product gate

Before user-facing integration, design an explicit opt-in invocation and
review surface, verify source/page/render identity through the product's
normal APIs, keep native text and OCR proposals separate, and test both false
words and absence of the optional engine. The default MCPB stays model-free
and unchanged. No public OCR claim follows from this prototype.
