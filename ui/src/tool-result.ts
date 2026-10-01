import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface PdfToolLoadData {
  pdfPath: string;
  activePath?: string;
  backupPath?: string | null;
  totalBytes: number;
  initialPage: number;
  fields: unknown[];
  fieldCount: number;
  hasFormFields: boolean;
  viewUUID?: string;
  key: string;
}

export interface PdfToolInputData {
  pdfPath: string;
  initialPage: number;
}

export type PdfToolLoadParseFailureKind = "missing" | "incomplete" | "invalid" | "conflict";

export type PdfToolLoadParseResult =
  | { ok: true; data: PdfToolLoadData }
  | {
      ok: false;
      kind: PdfToolLoadParseFailureKind;
      message: string;
      recoverablePdfPath?: string;
      initialPage: number;
    };

type UnknownRecord = Record<string, unknown>;

const LOAD_KEYS = [
  "pdfPath",
  "active_path",
  "backup_path",
  "totalBytes",
  "initialPage",
  "fields",
  "fieldCount",
  "hasFormFields",
  "viewUUID",
] as const;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

/** Presence, including an invalid/undefined value, prevents an empty state. */
export function hasPdfToolLoadMetadataKeys(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(record && LOAD_KEYS.some(key => key in record));
}

function hasLoadSignal(value: UnknownRecord | null) {
  return Boolean(value && LOAD_KEYS.some(key => value[key] !== undefined));
}

function valuesMatch(left: unknown, right: unknown) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function firstDefined(...values: unknown[]) {
  return values.find(value => value !== undefined);
}

function validNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function getInitialPage(value: unknown) {
  return validPositiveInteger(value) ? value : 1;
}

/**
 * Parse the redundant viewer payload without silently choosing between
 * contradictory structuredContent and _meta values.
 */
export function parsePdfToolLoadData(
  result: CallToolResult | null | undefined,
): PdfToolLoadParseResult {
  const structured = asRecord(result?.structuredContent);
  const meta = asRecord(result?._meta);
  const structuredHasLoadData = hasLoadSignal(structured);
  const metaHasLoadData = hasLoadSignal(meta);

  if (!structuredHasLoadData && !metaHasLoadData) {
    return {
      ok: false,
      kind: "missing",
      message: "The tool result did not include PDF viewer load metadata.",
      initialPage: 1,
    };
  }

  if (structuredHasLoadData && metaHasLoadData && structured && meta) {
    for (const key of LOAD_KEYS) {
      const structuredValue = structured[key];
      const metaValue = meta[key];
      if (
        structuredValue !== undefined &&
        metaValue !== undefined &&
        !valuesMatch(structuredValue, metaValue)
      ) {
        return {
          ok: false,
          kind: "conflict",
          message: `The tool result supplied conflicting PDF viewer metadata for ${key}.`,
          initialPage: getInitialPage(firstDefined(structured.initialPage, meta.initialPage)),
        };
      }
    }
  }

  const pdfPath = firstDefined(structured?.pdfPath, meta?.pdfPath);
  const totalBytes = firstDefined(structured?.totalBytes, meta?.totalBytes);
  const initialPageValue = firstDefined(structured?.initialPage, meta?.initialPage);
  const initialPage = getInitialPage(initialPageValue);

  if (pdfPath !== undefined && !validNonEmptyString(pdfPath)) {
    return {
      ok: false,
      kind: "invalid",
      message: "The tool result supplied an invalid PDF path.",
      initialPage,
    };
  }
  if (totalBytes !== undefined && !validPositiveInteger(totalBytes)) {
    return {
      ok: false,
      kind: "invalid",
      message: "The tool result supplied an invalid PDF byte length.",
      recoverablePdfPath: validNonEmptyString(pdfPath) ? pdfPath : undefined,
      initialPage,
    };
  }
  if (initialPageValue !== undefined && !validPositiveInteger(initialPageValue)) {
    return {
      ok: false,
      kind: "invalid",
      message: "The tool result supplied an invalid initial PDF page.",
      recoverablePdfPath: validNonEmptyString(pdfPath) ? pdfPath : undefined,
      initialPage: 1,
    };
  }

  if (!validNonEmptyString(pdfPath) || !validPositiveInteger(totalBytes)) {
    return {
      ok: false,
      kind: "incomplete",
      message: "The tool result supplied incomplete PDF viewer load metadata.",
      recoverablePdfPath: validNonEmptyString(pdfPath) ? pdfPath : undefined,
      initialPage,
    };
  }

  const activePathValue = firstDefined(structured?.active_path, meta?.active_path);
  if (activePathValue !== undefined && !validNonEmptyString(activePathValue)) {
    return {
      ok: false,
      kind: "invalid",
      message: "The tool result supplied an invalid active PDF path.",
      recoverablePdfPath: pdfPath,
      initialPage,
    };
  }

  const backupPathValue = firstDefined(structured?.backup_path, meta?.backup_path);
  if (
    backupPathValue !== undefined &&
    backupPathValue !== null &&
    !validNonEmptyString(backupPathValue)
  ) {
    return {
      ok: false,
      kind: "invalid",
      message: "The tool result supplied an invalid PDF backup path.",
      recoverablePdfPath: pdfPath,
      initialPage,
    };
  }

  const fieldCountValue = firstDefined(structured?.fieldCount, meta?.fieldCount, 0);
  if (!validNonNegativeInteger(fieldCountValue)) {
    return {
      ok: false,
      kind: "invalid",
      message: "The tool result supplied an invalid PDF form-field count.",
      recoverablePdfPath: pdfPath,
      initialPage,
    };
  }

  const hasFormFieldsValue = firstDefined(
    structured?.hasFormFields,
    meta?.hasFormFields,
    false,
  );
  if (typeof hasFormFieldsValue !== "boolean") {
    return {
      ok: false,
      kind: "invalid",
      message: "The tool result supplied an invalid PDF form-field flag.",
      recoverablePdfPath: pdfPath,
      initialPage,
    };
  }

  const structuredFields = structured?.fields;
  const metaFields = meta?.fields;
  if (structuredFields !== undefined && !Array.isArray(structuredFields)) {
    return {
      ok: false,
      kind: "invalid",
      message: "The tool result supplied invalid PDF form-field data.",
      recoverablePdfPath: pdfPath,
      initialPage,
    };
  }
  if (metaFields !== undefined && !Array.isArray(metaFields)) {
    return {
      ok: false,
      kind: "invalid",
      message: "The tool result supplied invalid PDF form-field data.",
      recoverablePdfPath: pdfPath,
      initialPage,
    };
  }

  const fields = Array.isArray(structuredFields) && structuredFields.length > 0
    ? structuredFields
    : Array.isArray(metaFields)
      ? metaFields
      : [];
  const viewUUIDValue = firstDefined(meta?.viewUUID, structured?.viewUUID);
  if (viewUUIDValue !== undefined && !validNonEmptyString(viewUUIDValue)) {
    return {
      ok: false,
      kind: "invalid",
      message: "The tool result supplied an invalid PDF viewer identity.",
      recoverablePdfPath: pdfPath,
      initialPage,
    };
  }

  const viewUUID = validNonEmptyString(viewUUIDValue) ? viewUUIDValue : undefined;
  const activePath = validNonEmptyString(activePathValue) ? activePathValue : undefined;
  const backupPath = validNonEmptyString(backupPathValue) ? backupPathValue : null;

  return {
    ok: true,
    data: {
      pdfPath,
      activePath,
      backupPath,
      totalBytes,
      initialPage,
      fields,
      fieldCount: fieldCountValue,
      hasFormFields: hasFormFieldsValue,
      viewUUID,
      key: `${activePath || pdfPath}:${totalBytes}:${initialPage}:${viewUUID || ""}`,
    },
  };
}

export function getPdfToolLoadData(
  result: CallToolResult | null | undefined,
): PdfToolLoadData | null {
  const parsed = parsePdfToolLoadData(result);
  return parsed.ok ? parsed.data : null;
}

export function getPdfToolInputData(params: unknown): PdfToolInputData | null {
  const input = asRecord(params);
  const args = asRecord(input?.arguments);
  if (!args || !validNonEmptyString(args.pdf_path)) return null;

  const page = args.page;
  const initialPage = typeof page === "number" && Number.isFinite(page) && page > 0
    ? Math.max(1, Math.floor(page))
    : 1;

  return {
    pdfPath: args.pdf_path,
    initialPage,
  };
}

export function getToolResultText(result: CallToolResult | null | undefined) {
  return result?.content
    ?.filter((block: any) => block.type === "text")
    .map((block: any) => String(block.text || ""))
    .join("\n")
    .trim() || "";
}

export function getDisplayPdfTextFileName(
  result: CallToolResult | null | undefined,
) {
  if (result?.isError) return null;
  const match = getToolResultText(result).match(
    /^Displaying:\s+([^\r\n]+?)\s+\(\d+\s+KB\)(?:\r?\n|$)/u,
  );
  return match?.[1]?.trim() || null;
}

export function isDisplayPdfTextResult(result: CallToolResult | null | undefined) {
  return getDisplayPdfTextFileName(result) !== null;
}
