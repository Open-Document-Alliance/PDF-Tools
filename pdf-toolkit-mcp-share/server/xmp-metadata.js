// Read and edit the document-level fields of an XMP packet, so that a
// metadata edit changes the Info dictionary and the XMP record together.
//
// Most readers prefer XMP to Info. Changing Info alone leaves the document
// telling two stories, and the one most viewers show is the old one. The
// fields handled here are the four Info has and the XMP properties that
// mirror them, as Acrobat pairs them:
//
//   Info /Title     <-> dc:title        (rdf:Alt, x-default)
//   Info /Author    <-> dc:creator      (rdf:Seq)
//   Info /Subject   <-> dc:description  (rdf:Alt, x-default)
//   Info /Keywords  <-> pdf:Keywords    (simple), and dc:subject (rdf:Bag)
//                                         when the packet already has one
//
// This is a targeted editor, not a general XML library: it resolves the
// packet's namespace prefixes, finds each property in element or attribute
// form, and refuses (with a reason) any packet where a property is ambiguous
// or the structure is not one it can rewrite without guessing. A refusal is
// returned to the caller, who stops before writing anything, so Info and XMP
// are never left disagreeing because of this module.

export const XMP_NAMESPACES = Object.freeze({
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  dc: "http://purl.org/dc/elements/1.1/",
  pdf: "http://ns.adobe.com/pdf/1.3/",
  xmp: "http://ns.adobe.com/xap/1.0/",
  xmpMM: "http://ns.adobe.com/xap/1.0/mm/",
});

export const XMP_MAX_BYTES = 4 * 1024 * 1024;

export class XmpUnsupported extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "XmpUnsupported";
    this.reason = reason;
  }
}

const FIELDS = Object.freeze({
  title: { ns: "dc", local: "title", shape: "alt" },
  author: { ns: "dc", local: "creator", shape: "seq" },
  subject: { ns: "dc", local: "description", shape: "alt" },
  keywords: { ns: "pdf", local: "Keywords", shape: "simple" },
});

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

/** Decode packet bytes. Only UTF-8 is handled; anything else is refused. */
export function decodeXmpPacket(bytes) {
  if (bytes.length > XMP_MAX_BYTES) {
    throw new XmpUnsupported("xmp_too_large", "The XMP packet is larger than PDF Tools will edit.");
  }
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe)) {
    throw new XmpUnsupported("xmp_not_utf8", "The XMP packet is UTF-16, which PDF Tools does not edit.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new XmpUnsupported("xmp_not_utf8", "The XMP packet is not valid UTF-8.");
  }
}

/**
 * Map each namespace URI the packet declares to the one prefix it uses. A URI
 * bound to two prefixes, or a prefix bound to two URIs, is refused: resolving
 * it would need real scoping, and a wrong guess edits the wrong property.
 */
function namespacePrefixes(xml) {
  const byUri = new Map();
  const byPrefix = new Map();
  for (const match of xml.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*(["'])(.*?)\2/g)) {
    const [, prefix, , uri] = match;
    if (byPrefix.has(prefix) && byPrefix.get(prefix) !== uri) {
      throw new XmpUnsupported("xmp_namespace_ambiguous", `The XMP prefix ${prefix} is bound to two namespaces.`);
    }
    byPrefix.set(prefix, uri);
    if (byUri.has(uri) && byUri.get(uri) !== prefix) {
      throw new XmpUnsupported("xmp_namespace_ambiguous", `The XMP namespace ${uri} is bound to two prefixes.`);
    }
    byUri.set(uri, prefix);
  }
  return byUri;
}

function prefixFor(prefixes, ns) {
  return prefixes.get(XMP_NAMESPACES[ns]) ?? null;
}

function elementPattern(qname) {
  const name = escapeRegExp(qname);
  return new RegExp(`<${name}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name}\\s*>)`, "g");
}

function attributePattern(qname) {
  return new RegExp(`(\\s)${escapeRegExp(qname)}\\s*=\\s*(["'])([\\s\\S]*?)\\2`, "g");
}

function liValues(inner, rdf) {
  const li = new RegExp(`<${escapeRegExp(rdf)}:li(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${escapeRegExp(rdf)}:li\\s*>)`, "g");
  return [...(inner ?? "").matchAll(li)].map(match => ({
    attributes: match[1] ?? "",
    value: unescapeXml(match[2] ?? ""),
  }));
}

function locate(xml, prefixes, field) {
  const spec = FIELDS[field];
  const prefix = prefixFor(prefixes, spec.ns);
  if (!prefix) return { prefix: null, elements: [], attributes: [] };
  const qname = `${prefix}:${spec.local}`;
  return {
    prefix,
    qname,
    elements: [...xml.matchAll(elementPattern(qname))],
    attributes: [...xml.matchAll(attributePattern(qname))],
  };
}

/**
 * Read the four document fields. Each comes back as { state, value }:
 * "absent", "value" (with a string), or "unsupported" (with a reason), so a
 * caller can report a coverage gap instead of an empty result.
 */
export function readXmpDocumentFields(xml) {
  let prefixes;
  try {
    prefixes = namespacePrefixes(xml);
  } catch (error) {
    if (!(error instanceof XmpUnsupported)) throw error;
    return Object.fromEntries(Object.keys(FIELDS).map(field => [field, { state: "unsupported", reason: error.reason }]));
  }
  const rdf = prefixFor(prefixes, "rdf");
  const out = {};
  for (const field of Object.keys(FIELDS)) {
    const spec = FIELDS[field];
    const found = locate(xml, prefixes, field);
    const count = found.elements.length + found.attributes.length;
    if (count === 0) {
      out[field] = { state: "absent" };
      continue;
    }
    if (count > 1) {
      out[field] = { state: "unsupported", reason: "xmp_property_repeated" };
      continue;
    }
    if (found.attributes.length === 1) {
      out[field] = spec.shape === "simple"
        ? { state: "value", value: unescapeXml(found.attributes[0][3]) }
        : { state: "unsupported", reason: "xmp_property_shape_unexpected" };
      continue;
    }
    const inner = found.elements[0][2];
    if (spec.shape === "simple") {
      out[field] = /</.test(inner ?? "")
        ? { state: "unsupported", reason: "xmp_property_shape_unexpected" }
        : { state: "value", value: unescapeXml(inner ?? "") };
      continue;
    }
    if (!rdf) {
      out[field] = { state: "unsupported", reason: "xmp_rdf_namespace_missing" };
      continue;
    }
    const items = liValues(inner, rdf);
    if (spec.shape === "alt") {
      const preferred = items.find(item => /xml:lang\s*=\s*["']x-default["']/.test(item.attributes)) ?? items[0];
      out[field] = preferred ? { state: "value", value: preferred.value } : { state: "absent" };
    } else {
      out[field] = items.length > 0
        ? { state: "value", value: items.map(item => item.value).join("; ") }
        : { state: "absent" };
    }
  }
  return out;
}

function propertyElement(qname, rdf, shape, value) {
  const text = escapeXml(value);
  if (shape === "alt") return `<${qname}><${rdf}:Alt><${rdf}:li xml:lang="x-default">${text}</${rdf}:li></${rdf}:Alt></${qname}>`;
  if (shape === "seq") return `<${qname}><${rdf}:Seq><${rdf}:li>${text}</${rdf}:li></${rdf}:Seq></${qname}>`;
  if (shape === "bag") {
    const terms = String(value).split(/[;,]/).map(term => term.trim()).filter(Boolean);
    return `<${qname}><${rdf}:Bag>${terms.map(term => `<${rdf}:li>${escapeXml(term)}</${rdf}:li>`).join("")}</${rdf}:Bag></${qname}>`;
  }
  return `<${qname}>${text}</${qname}>`;
}

function setProperty(xml, prefixes, rdf, { ns, local, shape }, value, { insertIfAbsent }) {
  const prefix = prefixFor(prefixes, ns);
  const qname = prefix ? `${prefix}:${local}` : null;
  const elements = qname ? [...xml.matchAll(elementPattern(qname))] : [];
  const attributes = qname ? [...xml.matchAll(attributePattern(qname))] : [];
  if (elements.length + attributes.length > 1) {
    throw new XmpUnsupported("xmp_property_repeated", `The XMP packet states ${ns}:${local} more than once.`);
  }
  if (attributes.length === 1) {
    if (shape !== "simple") {
      throw new XmpUnsupported("xmp_property_shape_unexpected", `The XMP packet states ${ns}:${local} in a form PDF Tools does not rewrite.`);
    }
    const match = attributes[0];
    if (value === null) return xml.slice(0, match.index) + xml.slice(match.index + match[0].length);
    return xml.slice(0, match.index) + `${match[1]}${qname}="${escapeXml(value)}"` + xml.slice(match.index + match[0].length);
  }
  if (elements.length === 1) {
    const match = elements[0];
    const replacement = value === null ? "" : propertyElement(qname, rdf, shape, value);
    return xml.slice(0, match.index) + replacement + xml.slice(match.index + match[0].length);
  }
  if (value === null || !insertIfAbsent) return xml;
  return insertProperty(xml, rdf, ns, local, shape, value, prefix);
}

/** Add a property in a new rdf:Description, which RDF merges with the others. */
function insertProperty(xml, rdf, ns, local, shape, value, existingPrefix) {
  const close = new RegExp(`</${escapeRegExp(rdf)}:RDF\\s*>`);
  const at = xml.search(close);
  if (at < 0) throw new XmpUnsupported("xmp_rdf_missing", "The XMP packet has no rdf:RDF element to add a property to.");
  const about = /rdf:about\s*=\s*(["'])(.*?)\1/.exec(xml)?.[2] ?? "";
  const prefix = existingPrefix ?? ns;
  const declaration = existingPrefix ? "" : ` xmlns:${prefix}="${XMP_NAMESPACES[ns]}"`;
  const description = `<${rdf}:Description ${rdf}:about="${escapeXml(about)}"${declaration}>`
    + `${propertyElement(`${prefix}:${local}`, rdf, shape, value)}</${rdf}:Description>\n`;
  return xml.slice(0, at) + description + xml.slice(at);
}

function refreshDate(xml, prefixes, local, iso) {
  const prefix = prefixFor(prefixes, "xmp");
  if (!prefix) return xml;
  return setProperty(xml, prefixes, null, { ns: "xmp", local, shape: "simple" }, iso, { insertIfAbsent: false });
}

/**
 * Apply edits to a packet. edits maps title/author/subject/keywords to a
 * string (set) or null (remove); a field not named is left alone. Returns
 * the new packet text. Throws XmpUnsupported, before any change is used, when
 * the packet cannot be edited without guessing.
 */
export function editXmpDocumentFields(xml, edits, { modifiedAt, instanceId = null } = {}) {
  const prefixes = namespacePrefixes(xml);
  const rdf = prefixFor(prefixes, "rdf");
  if (!rdf) throw new XmpUnsupported("xmp_rdf_namespace_missing", "The XMP packet does not declare the RDF namespace.");
  let out = xml;
  for (const [field, value] of Object.entries(edits)) {
    const spec = FIELDS[field];
    if (!spec) throw new TypeError(`Unknown XMP document field: ${field}`);
    out = setProperty(out, prefixes, rdf, spec, value, { insertIfAbsent: true });
    if (field === "keywords") {
      // dc:subject is the keyword list as a bag; keep it in step when present,
      // and do not invent one when the packet never had it.
      out = setProperty(out, prefixes, rdf, { ns: "dc", local: "subject", shape: "bag" }, value, { insertIfAbsent: false });
    }
  }
  if (modifiedAt) {
    out = refreshDate(out, prefixes, "ModifyDate", modifiedAt);
    out = refreshDate(out, prefixes, "MetadataDate", modifiedAt);
  }
  if (instanceId && prefixFor(prefixes, "xmpMM")) {
    out = setProperty(out, prefixes, rdf, { ns: "xmpMM", local: "InstanceID", shape: "simple" }, instanceId, { insertIfAbsent: false });
  }
  return out;
}

/**
 * A fresh XMP packet stating only the four document fields, from values the
 * caller already asserts in Info. Rebuilt outputs use this instead of copying
 * the source packet: copying could carry claims (PDF/A conformance, document
 * history, rights) that the rebuilt file does not meet, which
 * docs/METADATA_PROVENANCE.md forbids, while dropping XMP altogether leaves a
 * viewer that prefers XMP with no title. Fields that are null are omitted.
 */
export function xmpPacketFromInfo({ title = null, author = null, subject = null, keywords = null }, { modifiedAt = null } = {}) {
  const properties = [];
  if (title !== null) properties.push(propertyElement("dc:title", "rdf", "alt", title));
  if (author !== null) properties.push(propertyElement("dc:creator", "rdf", "seq", author));
  if (subject !== null) properties.push(propertyElement("dc:description", "rdf", "alt", subject));
  if (keywords !== null) properties.push(propertyElement("pdf:Keywords", "rdf", "simple", keywords));
  if (modifiedAt !== null) {
    properties.push(propertyElement("xmp:ModifyDate", "rdf", "simple", modifiedAt));
    properties.push(propertyElement("xmp:MetadataDate", "rdf", "simple", modifiedAt));
  }
  return "<?xpacket begin=\"﻿\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n"
    + "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n"
    + `<rdf:RDF xmlns:rdf="${XMP_NAMESPACES.rdf}">\n`
    + `<rdf:Description rdf:about="" xmlns:dc="${XMP_NAMESPACES.dc}" xmlns:pdf="${XMP_NAMESPACES.pdf}" xmlns:xmp="${XMP_NAMESPACES.xmp}">\n`
    + properties.join("\n")
    + "\n</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>";
}
