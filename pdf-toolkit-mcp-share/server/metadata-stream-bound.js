// Decide, from the file's bytes alone, whether PDF.js may read the document
// metadata without decoding an unbounded amount of data.
//
// PDF.js's getMetadata() reads the Info dictionary and the catalog /Metadata
// stream together, and decodes that stream in full before parsing it. Whether
// a given file is safe to hand to it therefore depends on which stream PDF.js
// will decode, and that is decided by PDF.js's own cross-reference handling.
// pdf-lib cannot answer for it: pdf-lib keeps the last definition of each
// object, PDF.js follows xref offsets (or reconstructs), so the two can see
// different streams under one object number.
//
// So nothing is resolved here. Streams cannot live inside object streams, so
// every stream PDF.js could ever decode appears literally in the file as
// "N G obj << ... >> stream". One forward pass finds each of them; any whose
// dictionary could make PDF.js decode it as XMP (/Type and /Subtype that are
// not provably other names) must be bounded: unfiltered, or a single
// FlateDecode whose raw data is at most METADATA_FLATE_RAW_LIMIT bytes
// (Flate expands at most about 1032:1). A candidate whose end cannot be
// determined the way PDF.js would determine it, or whose dictionary cannot be
// read, counts as unbounded, never as absent.
//
// The scan is linear in the file size: each "obj" and "stream" occurrence is
// visited once, and a dictionary is parsed at most once per object, only for
// an object that contains a "stream" keyword.

import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFObjectParser, PDFRef } from "pdf-lib";

export const METADATA_FLATE_RAW_LIMIT = 64 * 1024;

// Object headers plus stream keywords a scan will record. An ordinary file
// at the 250 MiB input cap has far fewer; past this the file is treated as
// unbounded rather than allocating without limit.
export const METADATA_SCAN_MARKER_LIMIT = 4_000_000;

const OBJ = Buffer.from("obj");
const STREAM = Buffer.from("stream");
const ENDSTREAM = Buffer.from("endstream");

function isWhitespace(byte) {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;
}

function isDigit(byte) {
  return byte >= 0x30 && byte <= 0x39;
}

function isDelimiter(byte) {
  return byte === undefined || isWhitespace(byte) || "()<>[]{}/%".includes(String.fromCharCode(byte));
}

/**
 * The object header ending at bytes[index - 1] ("N G" before "obj"), as
 * { number, generation }, or null. Whitespace between the parts is optional
 * before "obj", as in PDF.js's lexer.
 */
function headerBefore(bytes, index) {
  let cursor = index - 1;
  while (cursor >= 0 && isWhitespace(bytes[cursor])) cursor -= 1;
  const genEnd = cursor + 1;
  while (cursor >= 0 && isDigit(bytes[cursor])) cursor -= 1;
  if (cursor + 1 === genEnd || genEnd - (cursor + 1) > 5) return null;
  const generation = Number(bytes.toString("latin1", cursor + 1, genEnd));
  let spaced = false;
  while (cursor >= 0 && isWhitespace(bytes[cursor])) {
    cursor -= 1;
    spaced = true;
  }
  if (!spaced) return null;
  const numEnd = cursor + 1;
  while (cursor >= 0 && isDigit(bytes[cursor])) cursor -= 1;
  if (cursor + 1 === numEnd || numEnd - (cursor + 1) > 10) return null;
  if (cursor >= 0 && !isDelimiter(bytes[cursor])) return null;
  return { number: Number(bytes.toString("latin1", cursor + 1, numEnd)), generation };
}

/**
 * Every object header and every "stream" and "endstream" keyword, in file
 * order, as flat arrays of positions; null when there are more than
 * METADATA_SCAN_MARKER_LIMIT of them.
 */
function scan(bytes) {
  const headerEnds = [];
  const headerNumbers = [];
  const headerGenerations = [];
  const streams = [];
  const endstreams = [];
  let markers = 0;
  for (let at = bytes.indexOf(OBJ); at >= 0; at = bytes.indexOf(OBJ, at + OBJ.length)) {
    if (!isDelimiter(bytes[at + OBJ.length])) continue;
    const header = headerBefore(bytes, at);
    if (!header) continue;
    if (++markers > METADATA_SCAN_MARKER_LIMIT) return null;
    headerEnds.push(at + OBJ.length);
    headerNumbers.push(header.number);
    headerGenerations.push(header.generation);
  }
  for (let at = bytes.indexOf(STREAM); at >= 0; at = bytes.indexOf(STREAM, at + STREAM.length)) {
    if (++markers > METADATA_SCAN_MARKER_LIMIT) return null;
    const isEnd = at >= 3 && bytes[at - 3] === 0x65 && bytes[at - 2] === 0x6e && bytes[at - 1] === 0x64;
    if (isEnd) endstreams.push(at - 3);
    else streams.push(at);
  }
  return { headerEnds, headerNumbers, headerGenerations, streams, endstreams };
}

/** Skip whitespace and comments from index, as PDF.js's lexer does. */
function skipFiller(bytes, index) {
  let cursor = index;
  while (cursor < bytes.length) {
    if (isWhitespace(bytes[cursor])) {
      cursor += 1;
    } else if (bytes[cursor] === 0x25) {
      while (cursor < bytes.length && bytes[cursor] !== 0x0a && bytes[cursor] !== 0x0d) cursor += 1;
    } else {
      break;
    }
  }
  return cursor;
}

function endstreamAt(bytes, index) {
  const cursor = skipFiller(bytes, index);
  return cursor + ENDSTREAM.length <= bytes.length && bytes.subarray(cursor, cursor + ENDSTREAM.length).equals(ENDSTREAM);
}

/** First index in a sorted list that is >= value. */
function lowerBound(list, value) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function mayBeName(value, text) {
  if (value instanceof PDFRef) return true;
  return value instanceof PDFName && value.decodeText() === text;
}

/**
 * The stream dictionary of the object whose header ends at headerEnd and
 * whose next header ends at limit: { dict, streamAt } when the object is a
 * dictionary followed by the "stream" keyword, { unreadable: true } when a
 * dictionary there cannot be parsed but a stream keyword follows in the
 * object, or null when the object is not a stream.
 */
function streamDictionary(bytes, headerEnd, limit, streamsInObject, context) {
  const start = skipFiller(bytes, headerEnd);
  if (bytes[start] !== 0x3c || bytes[start + 1] !== 0x3c) return null;
  let dict;
  let end;
  try {
    const parser = PDFObjectParser.forBytes(bytes.subarray(start, Math.min(limit, bytes.length)), context);
    dict = parser.parseDict();
    end = start + parser.bytes.offset();
  } catch {
    // PDF.js's parser is more lenient than pdf-lib's. If any stream keyword
    // in this object begins a line of data, PDF.js might read it as a
    // stream whose dictionary this cannot see, so it cannot be cleared.
    const streamLike = streamsInObject.some(at => {
      const after = bytes[at + STREAM.length];
      return after === 0x0a || after === 0x0d || after === 0x20;
    });
    return streamLike ? { unreadable: true } : null;
  }
  if (!(dict instanceof PDFDict)) return null;
  const keyword = skipFiller(bytes, end);
  if (!bytes.subarray(keyword, keyword + STREAM.length).equals(STREAM) || !isDelimiter(bytes[keyword + STREAM.length])) {
    return null;
  }
  return { dict, streamAt: keyword };
}

/** Where PDF.js starts the stream data: after the line the keyword ends. */
function dataStart(bytes, streamAt) {
  let cursor = streamAt + STREAM.length;
  while (cursor < bytes.length && bytes[cursor] !== 0x0a && bytes[cursor] !== 0x0d) cursor += 1;
  if (bytes[cursor] === 0x0d && bytes[cursor + 1] === 0x0a) return cursor + 2;
  return cursor + 1;
}

function readInteger(bytes, at, context) {
  try {
    const parser = PDFObjectParser.forBytes(bytes.subarray(at, Math.min(bytes.length, at + 64)), context);
    const value = parser.parseObject();
    return value instanceof PDFNumber && Number.isSafeInteger(value.asNumber()) && value.asNumber() >= 0
      ? value.asNumber()
      : null;
  } catch {
    return null;
  }
}

/**
 * The raw data length PDF.js would use, given the /Length it would resolve
 * (null when there is none): the declared length when an endstream follows
 * it, otherwise the distance to the first endstream, which is where PDF.js
 * looks next. null when there is no endstream to find.
 */
function rawLength(bytes, declared, start, endstreams) {
  if (declared !== null && start + declared <= bytes.length && endstreamAt(bytes, start + declared)) return declared;
  const next = endstreams[lowerBound(endstreams, start)];
  return next === undefined ? null : next - start;
}

function filterIsFlate(filter) {
  const single = filter instanceof PDFArray && filter.size() === 1 ? filter.get(0) : filter;
  return single instanceof PDFName && (single.decodeText() === "FlateDecode" || single.decodeText() === "Fl");
}

/**
 * Whether every stream in the file that PDF.js could decode as XMP metadata
 * is bounded. Returns { bounded: true } or { bounded: false, reason }.
 */
export function metadataStreamsBounded(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const found = scan(bytes);
  if (found === null) return { bounded: false, reason: "too_many_objects" };
  const { headerEnds, headerNumbers, headerGenerations, streams, endstreams } = found;
  const context = PDFContext.create();
  // Candidates whose /Length is indirect, resolved in one more pass below.
  const pending = [];
  for (let index = 0; index < headerEnds.length; index += 1) {
    const limit = index + 1 < headerEnds.length ? headerEnds[index + 1] : bytes.length;
    const first = lowerBound(streams, headerEnds[index]);
    if (first >= streams.length || streams[first] >= limit) continue;
    let last = first;
    while (last < streams.length && streams[last] < limit) last += 1;
    const object = streamDictionary(bytes, headerEnds[index], limit, streams.slice(first, last), context);
    if (object === null) continue;
    if (object.unreadable) return { bounded: false, reason: "dictionary_unreadable" };
    const { dict, streamAt } = object;
    if (!mayBeName(dict.get(PDFName.of("Type")), "Metadata") || !mayBeName(dict.get(PDFName.of("Subtype")), "XML")) continue;
    const filter = dict.get(PDFName.of("Filter"));
    const unfiltered = filter === undefined || (filter instanceof PDFArray && filter.size() === 0);
    if (!unfiltered && !filterIsFlate(filter)) return { bounded: false, reason: "filter_unsupported" };
    const start = dataStart(bytes, streamAt);
    const length = dict.get(PDFName.of("Length"));
    if (length instanceof PDFRef) {
      pending.push({ ref: length, start, unfiltered });
      continue;
    }
    const declared = length instanceof PDFNumber && Number.isSafeInteger(length.asNumber()) && length.asNumber() >= 0
      ? length.asNumber()
      : null;
    const raw = rawLength(bytes, declared, start, endstreams);
    if (raw === null) return { bounded: false, reason: "stream_end_unknown" };
    if (!unfiltered && raw > METADATA_FLATE_RAW_LIMIT) return { bounded: false, reason: "stream_too_large" };
  }
  if (pending.length === 0) return { bounded: true };

  // An indirect /Length is read only from an object defined exactly once in
  // the file, so every parser reads the same value. One defined twice, or
  // not at all (for example, inside an object stream), is ambiguous.
  const key = (number, generation) => `${number} ${generation}`;
  const definitions = new Map(pending.map(entry => [key(entry.ref.objectNumber, entry.ref.generationNumber), []]));
  for (let index = 0; index < headerEnds.length; index += 1) {
    const list = definitions.get(key(headerNumbers[index], headerGenerations[index]));
    if (list && list.length < 2) list.push(headerEnds[index]);
  }
  for (const entry of pending) {
    const list = definitions.get(key(entry.ref.objectNumber, entry.ref.generationNumber));
    if (list.length !== 1) return { bounded: false, reason: "stream_end_unknown" };
    const declared = readInteger(bytes, list[0], context);
    if (declared === null) return { bounded: false, reason: "stream_end_unknown" };
    const raw = rawLength(bytes, declared, entry.start, endstreams);
    if (raw === null) return { bounded: false, reason: "stream_end_unknown" };
    if (!entry.unfiltered && raw > METADATA_FLATE_RAW_LIMIT) return { bounded: false, reason: "stream_too_large" };
  }
  return { bounded: true };
}
