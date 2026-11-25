/**
 * One hosted tool call in a child process started under RLIMIT_DATA by
 * process-isolation.mjs. In-memory only: no document persistence or user
 * filesystem access. `probe` mode answers the boot check without loading the
 * tool code.
 */
import { readFileSync } from "node:fs";

const mode = process.argv[2];

/** A one-page PDF whose text layer reads "Probe", built here so the probe needs no fixture file. */
const PROBE_PDF_BASE64 = (() => {
  const body = "BT /F1 12 Tf 72 720 Td (Probe) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => { const at = pdf.length; pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1").toString("base64");
})();

if (mode === "probe") {
  const limits = readFileSync("/proc/self/limits", "utf8").split("\n");
  const soft = name => Number((limits.find(entry => entry.startsWith(name)) ?? "").replace(name, "").trim().split(/\s+/)[0]);
  // One real PDF.js read under the limit, so a passing check means calls can run here.
  let toolCall = "failed";
  try {
    const { callTool } = await import("./server.mjs");
    const result = await callTool("read_pdf_pages", { pdf_base64: PROBE_PDF_BASE64, start_page: 1, end_page: 1 });
    if (!result.isError && JSON.stringify(result.structuredContent ?? {}).includes("Probe")) toolCall = "ok";
  } catch {}
  process.send({ probe: true, dataLimitBytes: soft("Max data size"), stackLimitBytes: soft("Max stack size"), toolCall }, () => process.exit(0));
} else {
  // A parent that is gone cannot use the result; do not keep working for it.
  process.once("disconnect", () => process.exit(1));
  process.once("message", async ({ name, args, context }) => {
    const { callTool } = await import("./server.mjs");
    const { isAllocationFailure, MEMORY_LIMIT_CODE, MEMORY_LIMIT_MESSAGE } = await import("./decode-budget.mjs");
    // A send whose interruption leaves an unknown outcome never gets a
    // substitute answer: the child exits and the parent reports it as unknown.
    const sensitive = name === "send_lumin_request";
    const substitute = error => (isAllocationFailure(error)
      ? { isError: true, content: [{ type: "text", text: `${MEMORY_LIMIT_CODE}: ${MEMORY_LIMIT_MESSAGE}` }] }
      : { isError: true, content: [{ type: "text", text: "PROCESSING_FAILED: That document could not be processed." }] });
    let result;
    try {
      result = await callTool(name, args, context);
    } catch (error) {
      if (sensitive) process.exit(1);
      result = substitute(error);
    }
    try {
      process.send(result, error => {
        if (!error) return process.exit(0);
        if (sensitive) return process.exit(1);
        // The result itself could not cross (for example, too large to serialize); send a small typed failure instead.
        try { process.send(substitute(error), () => process.exit(0)); } catch { process.exit(1); }
      });
    } catch (error) {
      if (sensitive) process.exit(1);
      try { process.send(substitute(error), () => process.exit(0)); } catch { process.exit(1); }
    }
  });
}
