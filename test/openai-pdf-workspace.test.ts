import { describe, expect, it } from "vitest";
import { isPdfWorkspaceResult, PDF_WORKSPACE_TASKS } from "../ui/src/workspace";

const empty = () => ({ structuredContent: { pdfWorkspace: { version: 1, state: "empty" } } });

describe("PDF Workspace entrypoint state", () => {
  it("recognizes only the versioned empty marker, without file metadata", () => {
    expect(isPdfWorkspaceResult(empty())).toBe(true);
    expect(isPdfWorkspaceResult({ ...empty(), _meta: { ui: { resourceUri: "ui://pdf-toolkit/viewer" } } })).toBe(true);
  });

  it.each([
    { isError: true, ...empty() },
    { structuredContent: { pdfWorkspace: { version: 2, state: "empty" } } },
    { structuredContent: { pdfWorkspace: { version: 1, state: "loaded" } } },
    { structuredContent: { pdfWorkspace: { version: 1, state: "empty", pdfPath: "/secret.pdf" } } },
    { structuredContent: { ...empty().structuredContent, pdfPath: "/secret.pdf" } },
    { ...empty(), _meta: { pdfPath: "/secret.pdf" } },
    { ...empty(), _meta: { activePath: "/secret.pdf" } },
    { ...empty(), _meta: { totalBytes: 20 } },
    { ...empty(), _meta: "invalid" },
    { structuredContent: { pdfWorkspace: [] } },
    { structuredContent: { pdfWorkspace: null } },
    { structuredContent: null },
    {},
  ])("does not turn malformed, conflicting or failed results into a welcome screen (%#)", result => {
    expect(isPdfWorkspaceResult(result)).toBe(false);
  });

  it.each([
    ["pdfPath", "/chosen.pdf"],
    ["active_path", "/chosen.pdf"],
    ["backup_path", "/backup.pdf"],
    ["totalBytes", 20],
    ["initialPage", 0],
    ["fields", []],
    ["fieldCount", 0],
    ["hasFormFields", false],
    ["viewUUID", "chosen-view"],
  ])("rejects the actual viewer load key %s even when its value is absent or invalid", (key, value) => {
    for (const metadataValue of [value, undefined, null]) {
      expect(isPdfWorkspaceResult({ ...empty(), _meta: { [key as string]: metadataValue } })).toBe(false);
      expect(isPdfWorkspaceResult({ structuredContent: { ...empty().structuredContent, [key as string]: metadataValue } })).toBe(false);
    }
  });

  it("offers broader document tasks, not a form-only replacement", () => {
    expect(PDF_WORKSPACE_TASKS.map(task => task.id)).toEqual(["review", "fill", "extract", "pages", "sign"]);
    for (const task of PDF_WORKSPACE_TASKS) {
      expect(task.prompt).toMatch(/Ask me|choose a document/);
      expect(task.prompt).not.toMatch(/user_confirmed_at|user_intent_statement|https?:/);
    }
    expect(PDF_WORKSPACE_TASKS.find(task => task.id === "sign")?.prompt).toContain("Do not apply a signature, send a PDF, or email signers");
    expect(PDF_WORKSPACE_TASKS.find(task => task.id === "review")?.prompt).toContain("Do not guess a file or scan folders");
  });
});
