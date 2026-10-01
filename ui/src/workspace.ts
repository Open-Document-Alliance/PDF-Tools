/** The entrypoint is a starting screen, not authority to read an active file. */
export function isPdfWorkspaceResult(result: {
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: unknown;
}): boolean {
  if (result.isError || !result.structuredContent || typeof result.structuredContent !== "object") return false;
  const content = result.structuredContent as Record<string, unknown>;
  if (Object.keys(content).join(",") !== "pdfWorkspace") return false;
  const workspace = content.pdfWorkspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return false;
  const marker = workspace as Record<string, unknown>;
  if (Object.keys(marker).sort().join(",") !== "state,version" || marker.version !== 1 || marker.state !== "empty") return false;
  // Never let an empty marker hide a conflicting file-bearing result.
  if (result._meta && (typeof result._meta !== "object" || Array.isArray(result._meta))) return false;
  const meta = result._meta as Record<string, unknown> | undefined;
  return !meta || !["pdfPath", "activePath", "totalBytes"].some(key => key in meta);
}

export const PDF_WORKSPACE_TASKS = Object.freeze([
  { id: "review", title: "Read and review", description: "See the pages, find text, and ask questions.", prompt: "Help me review a PDF using PDF Tools. Ask me which PDF to open. Do not guess a file or scan folders before I identify the document." },
  { id: "fill", title: "Fill a form", description: "Inspect fields and review the completed document.", prompt: "Help me fill a PDF form using PDF Tools. Ask me which PDF to use and the values I want. Do not make changes until I provide them." },
  { id: "extract", title: "Extract information", description: "Work through a document with source-backed answers.", prompt: "Help me extract information from a PDF using PDF Tools. Ask me which PDF and what information or schema I need. Preserve source citations and flag missing or unsupported information." },
  { id: "pages", title: "Arrange pages", description: "Plan a merge, split, rotation, or new page order.", prompt: "Help me arrange PDF pages using PDF Tools. Ask me which PDFs and which changes I want. Review the plan with me before changing documents." },
  { id: "sign", title: "Explore signing", description: "Review local stamps or a Lumin signing request.", prompt: "Explain the PDF Tools signing options and help me choose a document. Do not apply a signature, send a PDF, or email signers. Any signing or external send needs my separate explicit confirmation." },
]);
