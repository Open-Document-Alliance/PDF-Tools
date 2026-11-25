// Run one observe_document (the read behind get_pdf_info and compare_pdfs)
// in this process, the way Claude Desktop runs PDF.js, and report the
// metadata observation with this process's peak resident memory.
//
// Usage: node observe-document-rss.mjs <pdf-path>

import path from "node:path";
import { hashBoundedPdfFileSafely } from "../../server/bounded-pdf-file.js";
import { createPdfjsSubprocessRequest, runPdfjsSubprocess } from "../../server/pdfjs-subprocess.js";

const file = path.resolve(process.argv[2]);
const sourceFile = await hashBoundedPdfFileSafely(file, 250 * 1024 * 1024, {
  assertPathAllowed: candidate => candidate,
});
const result = await runPdfjsSubprocess(createPdfjsSubprocessRequest({
  operation: "observe_document",
  source: {
    canonical_path: sourceFile.canonicalPath,
    file_identity: sourceFile.fileIdentity,
    sha256: sourceFile.sha256,
    size_bytes: sourceFile.sizeBytes,
  },
  password: null,
  allowedDirectories: [path.dirname(file)],
  options: { max_pages: 1, max_output_characters: 20_000 },
}), { timeoutMs: 120_000, isolationMode: "in_process" });
process.stdout.write(JSON.stringify({
  reason_codes: result.coverage.metadata.reason_codes,
  info: result.metadata.info.values,
  xmp: result.metadata.xmp.values,
  max_rss_bytes: process.resourceUsage().maxRSS * 1024,
}));
process.exit(0);
