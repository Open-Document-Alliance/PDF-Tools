// Incremental update: append the objects a mutation changed after the
// original bytes, instead of rewriting the file.
//
// pdf-lib can only write a whole new file. That breaks every existing
// signature (a signature covers a byte range of the original file, and a
// rewrite moves every byte), and it re-encodes everything the operation did
// not touch. An incremental update leaves the original bytes exactly as they
// were and appends: the changed and new objects, a cross-reference section for
// them, and a trailer whose /Prev points at the original's. That is the
// mechanism ISO 32000 defines for editing a signed document, and the one
// Acrobat uses.
//
// What changed is found by digest, not by trusting the caller: right after
// load, every indirect object's pdf-lib serialization is hashed; after the
// mutation, any object whose serialization differs, and any new object, goes
// into the update. The caller cannot forget an object it touched indirectly
// (an appearance stream, a font, a /Kids array), and nothing it did not touch
// is rewritten.
//
// Limits, each refused with a reason rather than worked around:
// - An encrypted source cannot take an update here: the appended objects
//   would have to be encrypted with the source's keys, which only the qpdf
//   path holds, and that path rewrites. See server/qpdf-decrypt.js.
// - A source whose last startxref does not point at a cross-reference
//   section is damaged; appending to it would chain the update to nothing.
// - Deleting an object is not expressed (no mutation here deletes one).

import { createHash } from "node:crypto";
import {
  PDFArray,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
} from "pdf-lib";

export class IncrementalUpdateRefusal extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "IncrementalUpdateRefusal";
    this.reason = reason;
  }
}

const ASCII = new TextEncoder();
const TAIL_SCAN_BYTES = 2048;

function serialize(object) {
  const buffer = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(buffer, 0);
  return buffer;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Hash every indirect object as pdf-lib holds it, and reserve the object
 * numbers the original file uses. Take this immediately after load and before
 * any change, and load with { updateMetadata: false }: the default load
 * rewrites Producer and ModDate, which would make the snapshot describe a
 * document that was never on disk.
 *
 * The reservation keeps new objects (an appearance stream, a font) from being
 * numbered into the gap pdf-lib leaves where the original's object streams
 * and cross-reference streams were: an update that redefined one of those
 * numbers would hide everything stored in it.
 */
export function snapshotIndirectObjects(document, originalBytes = null) {
  if (originalBytes) {
    const { size } = locateLastCrossReference(originalBytes);
    if (document.context.largestObjectNumber < size - 1) document.context.largestObjectNumber = size - 1;
  }
  const snapshot = new Map();
  for (const [ref, object] of document.context.enumerateIndirectObjects()) {
    snapshot.set(ref.toString(), digest(serialize(object)));
  }
  return snapshot;
}

/**
 * Locate the original file's last cross-reference section. Returns
 * { offset, kind, size } with kind "table" or "stream" and size that
 * section's /Size, or throws a refusal.
 *
 * The /Size matters: it counts every object number the file uses, including
 * object streams and cross-reference streams that pdf-lib drops from its
 * context once it has parsed them. Allocating new numbers from pdf-lib's view
 * alone would reuse one of those, and the update would shadow the object
 * stream that holds the catalog.
 */
export function locateLastCrossReference(bytes) {
  const tailStart = Math.max(0, bytes.length - TAIL_SCAN_BYTES);
  const tail = Buffer.from(bytes.subarray(tailStart)).toString("latin1");
  const marker = tail.lastIndexOf("startxref");
  if (marker < 0) {
    throw new IncrementalUpdateRefusal("no_startxref", "The PDF has no startxref, so an update cannot be chained to it.");
  }
  const match = /^startxref\s+(\d+)/.exec(tail.slice(marker));
  const offset = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) {
    throw new IncrementalUpdateRefusal("bad_startxref", "The PDF's startxref offset is outside the file.");
  }
  const head = Buffer.from(bytes.subarray(offset, Math.min(bytes.length, offset + 64))).toString("latin1");
  const sizeIn = text => {
    const match = /\/Size\s+(\d+)/.exec(text);
    const size = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new IncrementalUpdateRefusal("damaged_cross_reference", "The PDF's last cross-reference section has no usable /Size.");
    }
    return size;
  };
  if (/^xref\b/.test(head)) {
    const section = Buffer.from(bytes.subarray(offset)).toString("latin1");
    const trailer = section.indexOf("trailer");
    const end = section.indexOf("startxref", trailer);
    if (trailer < 0 || end < 0) {
      throw new IncrementalUpdateRefusal("damaged_cross_reference", "The PDF's last cross-reference table has no trailer.");
    }
    return { offset, kind: "table", size: sizeIn(section.slice(trailer, end)) };
  }
  if (/^\d+\s+\d+\s+obj\b/.test(head)) {
    const window = Buffer.from(bytes.subarray(offset, Math.min(bytes.length, offset + 4096))).toString("latin1");
    const dictionaryEnd = window.indexOf("stream");
    const dictionary = dictionaryEnd < 0 ? window : window.slice(0, dictionaryEnd);
    if (/\/Type\s*\/XRef\b/.test(dictionary)) return { offset, kind: "stream", size: sizeIn(dictionary) };
  }
  throw new IncrementalUpdateRefusal(
    "damaged_cross_reference",
    "The PDF's startxref does not point at a cross-reference section, so the file is damaged and an update cannot be chained to it.",
  );
}

function changedObjects(document, snapshot) {
  const changed = [];
  for (const [ref, object] of document.context.enumerateIndirectObjects()) {
    const bytes = serialize(object);
    const before = snapshot.get(ref.toString());
    if (before === undefined || before !== digest(bytes)) changed.push({ ref, bytes });
  }
  const live = new Set(document.context.enumerateIndirectObjects().map(([ref]) => ref.toString()));
  for (const key of snapshot.keys()) {
    if (!live.has(key)) {
      throw new IncrementalUpdateRefusal("object_deleted", `The change removed object ${key}, which an update here does not express.`);
    }
  }
  return changed.sort((left, right) => left.ref.objectNumber - right.ref.objectNumber);
}

/** Group sorted object numbers into [first, count] runs. */
function subsections(numbers) {
  const runs = [];
  for (const number of numbers) {
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === number) last[1] += 1;
    else runs.push([number, 1]);
  }
  return runs;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function updatedFileIdentifier(context, appendedDigest) {
  const id = context.lookup(context.trailerInfo.ID);
  const second = PDFHexString.of(appendedDigest.slice(0, 32));
  if (id instanceof PDFArray && id.size() === 2) {
    return context.obj([id.get(0), second]);
  }
  return context.obj([second, second]);
}

function trailerEntries(context, size, prev, appendedDigest) {
  const entries = {
    Size: PDFNumber.of(size),
    Prev: PDFNumber.of(prev),
    Root: context.trailerInfo.Root,
  };
  if (context.trailerInfo.Info instanceof PDFRef) entries.Info = context.trailerInfo.Info;
  entries.ID = updatedFileIdentifier(context, appendedDigest);
  return entries;
}

function entryRow(type, field2, field3) {
  const row = new Uint8Array(7);
  row[0] = type;
  row[1] = (field2 >>> 24) & 0xff;
  row[2] = (field2 >>> 16) & 0xff;
  row[3] = (field2 >>> 8) & 0xff;
  row[4] = field2 & 0xff;
  row[5] = (field3 >>> 8) & 0xff;
  row[6] = field3 & 0xff;
  return row;
}

/**
 * Build the appended bytes. Returns the full output (original + update) and a
 * summary. The update uses the same cross-reference kind as the original's
 * last section, because a reader that found the original through an xref
 * stream is the reader the update must also satisfy.
 */
export function buildIncrementalUpdate(document, originalBytes, snapshot) {
  if (document.context.trailerInfo.Encrypt) {
    throw new IncrementalUpdateRefusal("encrypted", "An encrypted PDF cannot be updated incrementally here.");
  }
  const crossReference = locateLastCrossReference(originalBytes);
  const changed = changedObjects(document, snapshot);
  if (changed.length === 0) {
    throw new IncrementalUpdateRefusal("no_change", "The operation changed nothing, so there is nothing to append.");
  }
  const context = document.context;
  for (const { ref } of changed) {
    if (!snapshot.has(ref.toString()) && ref.objectNumber < crossReference.size) {
      throw new IncrementalUpdateRefusal(
        "object_number_reused",
        `A new object was numbered ${ref.objectNumber}, which the original file already uses.`,
      );
    }
  }
  const parts = [];
  let position = originalBytes.length;
  const needsNewline = originalBytes[originalBytes.length - 1] !== 0x0a && originalBytes[originalBytes.length - 1] !== 0x0d;
  if (needsNewline) {
    parts.push(ASCII.encode("\n"));
    position += 1;
  }
  const offsets = new Map();
  for (const { ref, bytes } of changed) {
    offsets.set(ref.objectNumber, { offset: position, generation: ref.generationNumber });
    const head = ASCII.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    const foot = ASCII.encode("\nendobj\n");
    parts.push(head, bytes, foot);
    position += head.length + bytes.length + foot.length;
  }
  const appendedDigest = digest(concat(parts));
  let size = Math.max(crossReference.size, context.largestObjectNumber + 1);
  for (const number of offsets.keys()) size = Math.max(size, number + 1);

  if (crossReference.kind === "table") {
    const xrefOffset = position;
    const lines = ["xref"];
    for (const [first, count] of subsections([...offsets.keys()])) {
      lines.push(`${first} ${count}`);
      for (let number = first; number < first + count; number += 1) {
        const entry = offsets.get(number);
        lines.push(`${String(entry.offset).padStart(10, "0")} ${String(entry.generation).padStart(5, "0")} n\r`);
      }
    }
    const trailer = context.obj(trailerEntries(context, size, crossReference.offset, appendedDigest));
    parts.push(ASCII.encode(`${lines.join("\n")}\ntrailer\n`), serialize(trailer), ASCII.encode(`\nstartxref\n${xrefOffset}\n%%EOF\n`));
  } else {
    const streamNumber = size;
    size += 1;
    offsets.set(streamNumber, { offset: position, generation: 0 });
    const numbers = [...offsets.keys()].sort((left, right) => left - right);
    const runs = subsections(numbers);
    const rows = [];
    for (const number of numbers) {
      const entry = offsets.get(number);
      if (entry.offset > 0xffffffff || entry.generation > 0xffff) {
        throw new IncrementalUpdateRefusal("too_large", "The update exceeds the cross-reference stream field widths.");
      }
      rows.push(entryRow(1, entry.offset, entry.generation));
    }
    const data = concat(rows);
    const dict = context.obj({
      Type: PDFName.of("XRef"),
      W: context.obj([1, 4, 2]),
      Index: context.obj(runs.flat()),
      Length: PDFNumber.of(data.length),
      ...trailerEntries(context, size, crossReference.offset, appendedDigest),
    });
    const head = ASCII.encode(`${streamNumber} 0 obj\n`);
    const body = concat([serialize(dict), ASCII.encode("\nstream\n"), data, ASCII.encode("\nendstream\nendobj\n")]);
    parts.push(head, body, ASCII.encode(`startxref\n${position}\n%%EOF\n`));
  }
  const output = concat([originalBytes, ...parts]);
  return {
    bytes: output,
    summary: {
      appended_objects: changed.length,
      original_bytes: originalBytes.length,
      cross_reference: crossReference.kind,
    },
  };
}

/** True when `bytes` begins with exactly `prefix`. */
export function keepsPrefix(bytes, prefix) {
  if (bytes.length <= prefix.length) return false;
  return Buffer.from(bytes.buffer, bytes.byteOffset, prefix.length)
    .equals(Buffer.from(prefix.buffer, prefix.byteOffset, prefix.length));
}
