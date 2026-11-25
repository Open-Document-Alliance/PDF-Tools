// What a document's existing signatures permit a later change to do.
//
// A /Sig field is not a signature until it has a value: an empty field is a
// place to sign, and treating it as a signature used to make every later edit
// refuse a document nobody had signed. A field with a /V signature dictionary
// is a signature, and an edit to the document either keeps the bytes it
// covers (an incremental update) or breaks it.
//
// Two declarations in the file restrict what may change after signing:
// - DocMDP, a certification signature: /P 1 permits no change at all,
//   /P 2 permits filling forms and signing, /P 3 also permits annotations.
//   Changing document metadata is in none of those lists.
// - FieldMDP, a /Lock on a signature field: the fields it names may not be
//   changed once that field is signed.
// Both are read here and enforced by the callers; nothing here guesses past
// a malformed declaration, which reads as the strictest one.

import { PDFArray, PDFDict, PDFName, PDFRef, PDFString, PDFHexString, PDFNumber } from "pdf-lib";

const N = Object.freeze({
  Action: PDFName.of("Action"),
  All: PDFName.of("All"),
  DocMDP: PDFName.of("DocMDP"),
  Exclude: PDFName.of("Exclude"),
  Fields: PDFName.of("Fields"),
  FT: PDFName.of("FT"),
  Include: PDFName.of("Include"),
  Kids: PDFName.of("Kids"),
  Lock: PDFName.of("Lock"),
  P: PDFName.of("P"),
  Parent: PDFName.of("Parent"),
  Perms: PDFName.of("Perms"),
  Reference: PDFName.of("Reference"),
  Sig: PDFName.of("Sig"),
  T: PDFName.of("T"),
  TransformMethod: PDFName.of("TransformMethod"),
  TransformParams: PDFName.of("TransformParams"),
  V: PDFName.of("V"),
});

const MAX_FIELD_NODES = 10_000;

function lookup(context, value) {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

function text(value) {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    try { return value.decodeText(); } catch { return ""; }
  }
  return "";
}

function inherited(context, node, key) {
  let current = node;
  for (let depth = 0; current instanceof PDFDict && depth < 32; depth += 1) {
    if (current.has(key)) return lookup(context, current.get(key));
    current = lookup(context, current.get(N.Parent));
  }
  return undefined;
}

function qualifiedName(context, node) {
  const parts = [];
  let current = node;
  for (let depth = 0; current instanceof PDFDict && depth < 32; depth += 1) {
    const name = text(lookup(context, current.get(N.T)));
    if (name) parts.unshift(name);
    current = lookup(context, current.get(N.Parent));
  }
  return parts.join(".");
}

function lockOf(context, field) {
  const lock = lookup(context, field.get(N.Lock));
  if (!(lock instanceof PDFDict)) return null;
  const action = lookup(context, lock.get(N.Action));
  const names = lookup(context, lock.get(N.Fields));
  const listed = names instanceof PDFArray ? names.asArray().map(item => text(lookup(context, item))) : [];
  if (action === N.All) return { action: "all", fields: [] };
  if (action === N.Include) return { action: "include", fields: listed };
  if (action === N.Exclude) return { action: "exclude", fields: listed };
  return { action: "all", fields: [] };
}

/** The DocMDP permission level, 1-3, or null when the document is not certified. */
function docMdpLevel(document) {
  const context = document.context;
  const perms = lookup(context, document.catalog.get(N.Perms));
  if (!(perms instanceof PDFDict)) return null;
  const signature = lookup(context, perms.get(N.DocMDP));
  if (!(signature instanceof PDFDict)) return perms.has(N.DocMDP) ? 1 : null;
  const references = lookup(context, signature.get(N.Reference));
  if (!(references instanceof PDFArray)) return 2;
  for (const item of references.asArray()) {
    const reference = lookup(context, item);
    if (!(reference instanceof PDFDict)) continue;
    if (lookup(context, reference.get(N.TransformMethod)) !== N.DocMDP) continue;
    const params = lookup(context, reference.get(N.TransformParams));
    const level = params instanceof PDFDict ? lookup(context, params.get(N.P)) : undefined;
    if (level === undefined) return 2;
    if (!(level instanceof PDFNumber) || ![1, 2, 3].includes(level.asNumber())) return 1;
    return level.asNumber();
  }
  return 2;
}

/**
 * { signed: [{ name, lock }], unsigned: [name], certification: 1|2|3|null }.
 * Walks the AcroForm field tree directly, with a node bound and cycle
 * refusal, rather than through pdf-lib's form API, which creates an AcroForm
 * as a side effect and would itself be a change to the document.
 */
export function inspectSignatureState(document) {
  const context = document.context;
  const state = { signed: [], unsigned: [], certification: docMdpLevel(document) };
  const acroForm = lookup(context, document.catalog.get(PDFName.of("AcroForm")));
  if (!(acroForm instanceof PDFDict)) return state;
  const fields = lookup(context, acroForm.get(N.Fields));
  if (!(fields instanceof PDFArray)) return state;
  const pending = [...fields.asArray()];
  const seen = new Set();
  while (pending.length > 0) {
    if (seen.size > MAX_FIELD_NODES) break;
    const raw = pending.pop();
    const node = lookup(context, raw);
    if (!(node instanceof PDFDict) || seen.has(node)) continue;
    seen.add(node);
    const kids = lookup(context, node.get(N.Kids));
    const childFields = kids instanceof PDFArray
      ? kids.asArray().filter(kid => lookup(context, kid) instanceof PDFDict && lookup(context, kid).has(N.T))
      : [];
    if (childFields.length > 0) {
      pending.push(...childFields);
      continue;
    }
    if (inherited(context, node, N.FT) !== N.Sig) continue;
    const name = qualifiedName(context, node);
    const value = inherited(context, node, N.V);
    if (value instanceof PDFDict) state.signed.push({ name, lock: lockOf(context, node) });
    else state.unsigned.push(name);
  }
  return state;
}

/**
 * True when a signed field's /Lock forbids changing the named field: an
 * "all" lock covers every field, "include" the listed ones, and "exclude"
 * every field except the listed ones.
 */
export function isFieldLocked(state, fieldName) {
  return state.signed.some(({ lock }) => {
    if (!lock) return false;
    if (lock.action === "all") return true;
    if (lock.action === "include") return lock.fields.includes(fieldName);
    return !lock.fields.includes(fieldName);
  });
}
