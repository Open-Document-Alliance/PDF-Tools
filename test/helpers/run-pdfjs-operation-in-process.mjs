// Run one PDF.js operation in this process, the way Claude Desktop runs
// PDF.js, and print its outcome with this process's peak resident memory.
//
// Usage: node run-pdfjs-operation-in-process.mjs <operation> <options-json> <pdf-path>

import path from "node:path";
import { hashBoundedPdfFileSafely } from "../../server/bounded-pdf-file.js";
import { createPdfjsSubprocessRequest, runPdfjsSubprocess } from "../../server/pdfjs-subprocess.js";

const [operation, optionsJson, pdfPath] = process.argv.slice(2);
const file = path.resolve(pdfPath);
const sourceFile = await hashBoundedPdfFileSafely(file, 250 * 1024 * 1024, {
  assertPathAllowed: candidate => candidate,
});
const options = JSON.parse(optionsJson.replaceAll("$SOURCE_PATH", file).replaceAll("$SOURCE_NAME", path.basename(file)));
let outcome;
try {
  await runPdfjsSubprocess(createPdfjsSubprocessRequest({
    operation,
    source: {
      canonical_path: sourceFile.canonicalPath,
      file_identity: sourceFile.fileIdentity,
      sha256: sourceFile.sha256,
      size_bytes: sourceFile.sizeBytes,
    },
    password: null,
    allowedDirectories: [path.dirname(file)],
    options,
  }), { timeoutMs: 180_000, isolationMode: "in_process" });
  outcome = { status: "ok", code: null, reason: null };
} catch (error) {
  outcome = { status: "failed", code: error?.code ?? null, reason: error?.reason ?? null };
}
process.stdout.write(JSON.stringify({ ...outcome, max_rss_bytes: process.resourceUsage().maxRSS * 1024 }));
process.exit(0);
