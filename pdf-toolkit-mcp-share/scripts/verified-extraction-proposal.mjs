import { createHash } from "node:crypto";

import {
  DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
  readSourceBoundDocumentChunk,
  validateSourceBoundDocumentMap,
} from "../server/document-map.js";
import {
  canonicalWorkspaceJson,
  inspectExtractionWorkspace,
  readExtractionWorkspacePage,
} from "./verified-extraction-workspace.mjs";
import { parseStrictJson } from "./eval-strict-json.mjs";

export const EXTRACTION_PROPOSAL_VERIFIER = Object.freeze({
  name: "pdf-tools.verified-extraction-proposal-verifier",
  version: "1.1.0-experimental",
});

export const EXTRACTION_PROPOSAL_STATUSES = Object.freeze([
  "verified_exact",
  "source_supported",
  "computed_with_inputs",
  "ambiguous",
  "citation_mismatch",
  "unverified_reasoning",
  "chunk_missing",
]);

export const EXTRACTION_PROPOSAL_CLAIM_BOUNDARY =
  "Citations are reconstructed from fresh source-bound chunks. Exact projections and allowlisted calculations are mechanically replayed. Source-supported, ambiguous, and unverified-reasoning statuses preserve semantic uncertainty. A caller-declared absence remains unverified reasoning even when the complete source scope is available. Caller text, geometry, confidence, and table topology are never accepted as proof.";

function unverifiedAbsence() {
  return { status: "unverified_reasoning", derived_value: null, calculation: null,
    reasons: ["ABSENCE_NOT_MECHANICALLY_PROVEN"] };
}

const SHA256 = /^[a-f0-9]{64}$/u;
const EVENT_ID = /^event\.[a-f0-9]{64}$/u;
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const MAX_CITATIONS = 32;
const MAX_EVENTS = 50000;
const MAX_CALCULATION_INPUTS = 32;
const MAX_DECIMAL_DIGITS = 80;
const MAX_ANY_OF_BRANCHES = 16;
const SCHEMA_ANNOTATION_KEYS = ["$id", "$schema", "description", "title"];

function fail(message) {
  throw new Error(`Invalid extraction proposal verification: ${message}`);
}

function assertion(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value) {
  return sha256(Buffer.from(canonicalWorkspaceJson(value), "utf8"));
}

function exactKeys(value, keys, label) {
  assertion(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assertion(canonicalWorkspaceJson(Object.keys(value).sort())
    === canonicalWorkspaceJson([...keys].sort()), `${label} keys are invalid`);
}

function jsonValue(value, depth = 0, count = { value: 0 }) {
  assertion(depth <= 32, "JSON value exceeds the depth limit");
  count.value += 1;
  assertion(count.value <= 10000, "JSON value exceeds the node limit");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    assertion(Number.isFinite(value), "JSON number is not finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1, count));
  assertion(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype,
    "JSON value must contain only plain objects");
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonValue(value[key], depth + 1, count)]));
}

function validateExactSchemaNumberTokens(text) {
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\"") {
      index += 1;
      while (index < text.length && text[index] !== "\"") {
        index += text[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (text[index] === "-" || /[0-9]/u.test(text[index])) {
      const match = text.slice(index).match(
        /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u,
      );
      assertion(match, "schema contains an invalid numeric token");
      const token = match[0];
      assertion(/^(?:0|-?[1-9][0-9]*)$/u.test(token),
        "schema contains a non-canonical or inexact numeric token");
      const exact = BigInt(token);
      assertion(exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER),
        "schema contains a numeric token outside the exact safe-integer subset");
      index += token.length;
      continue;
    }
    index += 1;
  }
}

function parseSchema(schemaBytes) {
  assertion(Buffer.isBuffer(schemaBytes) || schemaBytes instanceof Uint8Array,
    "schemaBytes must be exact bytes");
  const bytes = Buffer.from(schemaBytes);
  assertion(bytes.length > 0 && bytes.length <= 1024 * 1024, "schemaBytes are outside the supported bound");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("schemaBytes are not valid UTF-8");
  }
  validateExactSchemaNumberTokens(text);
  let schema;
  try {
    schema = parseStrictJson(text, "schemaBytes");
  } catch (error) {
    fail(error.message);
  }
  const normalized = jsonValue(schema);
  validateSupportedSchemaNode(normalized, "$", true);
  return normalized;
}

function encodePointerSegment(value) {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

export function compileExtractionLeafObligations(schemaBytes) {
  const schema = parseSchema(schemaBytes);
  const leaves = [];
  const visit = (node, pointer) => {
    if (node.type === "object" && !Array.isArray(node.anyOf)) {
      for (const key of Object.keys(node.properties).sort()) {
        visit(node.properties[key], `${pointer}/${encodePointerSegment(key)}`);
      }
      return;
    }
    assertion(pointer !== "", "root schema must contain at least one leaf obligation");
    leaves.push(pointer);
  };
  visit(schema, "");
  assertion(leaves.length > 0 && leaves.length <= 10000,
    "schema leaf obligations are outside the supported bound");
  return leaves;
}

function supportedSchemaKeys(type) {
  if (type === "object") return [
    ...SCHEMA_ANNOTATION_KEYS, "type", "properties", "required", "additionalProperties",
  ];
  if (type === "array") return [
    ...SCHEMA_ANNOTATION_KEYS, "type", "items", "minItems", "maxItems", "uniqueItems", "x-key",
  ];
  if (type === "string") return [
    ...SCHEMA_ANNOTATION_KEYS, "type", "const", "enum", "format", "minLength", "maxLength",
  ];
  if (type === "number" || type === "integer") return [
    ...SCHEMA_ANNOTATION_KEYS, "type", "const", "enum", "minimum", "maximum",
  ];
  return [...SCHEMA_ANNOTATION_KEYS, "type", "const", "enum"];
}

function validateExactSchemaJsonNumbers(value, at) {
  if (typeof value === "number") {
    assertion(Number.isSafeInteger(value),
      `schema node ${at} contains a numeric value outside the exact safe-integer subset`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateExactSchemaJsonNumbers(item, `${at}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => (
      validateExactSchemaJsonNumbers(item, `${at}[${JSON.stringify(key)}]`)
    ));
  }
}

function validateSupportedSchemaNode(schema, at, root = false) {
  assertion(schema && typeof schema === "object" && !Array.isArray(schema),
    `schema node ${at} must be an object`);
  if (Object.hasOwn(schema, "anyOf")) {
    exactKeys(schema, [...SCHEMA_ANNOTATION_KEYS, "anyOf"].filter(key => Object.hasOwn(schema, key)),
      `schema node ${at}`);
    assertion(Array.isArray(schema.anyOf) && schema.anyOf.length >= 1
      && schema.anyOf.length <= MAX_ANY_OF_BRANCHES, `schema node ${at} anyOf is outside the supported bound`);
    schema.anyOf.forEach((candidate, index) => validateSupportedSchemaNode(candidate, `${at}.anyOf[${index}]`));
    return;
  }
  const type = schema.type;
  assertion(["object", "array", "string", "number", "integer", "boolean", "null"].includes(type),
    `schema node ${at} has an unsupported type`);
  exactKeys(schema, supportedSchemaKeys(type).filter(key => Object.hasOwn(schema, key)), `schema node ${at}`);
  if (root) {
    assertion(type === "object", "root schema must be an object schema");
  }
  if (Object.hasOwn(schema, "const")) {
    jsonValue(schema.const);
    validateExactSchemaJsonNumbers(schema.const, `${at}.const`);
  }
  if (Object.hasOwn(schema, "enum")) {
    assertion(Array.isArray(schema.enum) && schema.enum.length >= 1
      && new Set(schema.enum.map(canonicalWorkspaceJson)).size === schema.enum.length,
    `schema node ${at} enum is invalid`);
    schema.enum.forEach((item, index) => {
      jsonValue(item);
      validateExactSchemaJsonNumbers(item, `${at}.enum[${index}]`);
    });
  }
  if (type === "object") {
    assertion(schema.properties && typeof schema.properties === "object"
      && !Array.isArray(schema.properties) && Object.getPrototypeOf(schema.properties) === Object.prototype,
    `schema node ${at} properties are invalid`);
    assertion(schema.additionalProperties === undefined || typeof schema.additionalProperties === "boolean",
      `schema node ${at} additionalProperties is unsupported`);
    const propertyNames = Object.keys(schema.properties);
    assertion(Array.isArray(schema.required) || schema.required === undefined,
      `schema node ${at} required is invalid`);
    const required = schema.required ?? [];
    assertion(required.every(key => typeof key === "string" && propertyNames.includes(key))
      && new Set(required).size === required.length, `schema node ${at} required is invalid`);
    Object.entries(schema.properties).forEach(([key, child]) => (
      validateSupportedSchemaNode(child, `${at}.properties[${JSON.stringify(key)}]`)
    ));
  } else if (type === "array") {
    validateSupportedSchemaNode(schema.items, `${at}.items`);
    for (const key of ["minItems", "maxItems"]) {
      assertion(schema[key] === undefined || (Number.isSafeInteger(schema[key]) && schema[key] >= 0),
        `schema node ${at} ${key} is invalid`);
    }
    assertion(schema.minItems === undefined || schema.maxItems === undefined
      || schema.minItems <= schema.maxItems, `schema node ${at} item bounds are invalid`);
    assertion(schema.uniqueItems === undefined || typeof schema.uniqueItems === "boolean",
      `schema node ${at} uniqueItems is invalid`);
    if (Object.hasOwn(schema, "x-key")) {
      assertion(typeof schema["x-key"] === "string" && schema["x-key"].length >= 1
        && schema.items.type === "object" && Object.hasOwn(schema.items.properties, schema["x-key"])
        && schema.items.properties[schema["x-key"]].type === "string",
      `schema node ${at} x-key is invalid`);
    }
  } else if (type === "string") {
    for (const key of ["minLength", "maxLength"]) {
      assertion(schema[key] === undefined || (Number.isSafeInteger(schema[key]) && schema[key] >= 0),
        `schema node ${at} ${key} is invalid`);
    }
    assertion(schema.minLength === undefined || schema.maxLength === undefined
      || schema.minLength <= schema.maxLength, `schema node ${at} string bounds are invalid`);
    assertion(schema.format === undefined || schema.format === "date",
      `schema node ${at} format is unsupported`);
  } else if (type === "number" || type === "integer") {
    assertion(schema.minimum === undefined || Number.isSafeInteger(schema.minimum),
      `schema node ${at} minimum is invalid`);
    assertion(schema.maximum === undefined || Number.isSafeInteger(schema.maximum),
      `schema node ${at} maximum is invalid`);
    assertion(schema.minimum === undefined || schema.maximum === undefined || schema.minimum <= schema.maximum,
      `schema node ${at} numeric bounds are invalid`);
  }
}

function validCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= lengths[month - 1];
}

function decodePointer(pointer) {
  assertion(typeof pointer === "string" && /^(?:\/(?:[^~/]|~[01])*)*$/u.test(pointer),
    "leaf pointer is invalid");
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map(segment => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function resolveSchemaLeaf(schema, pointer) {
  let current = schema;
  for (const segment of decodePointer(pointer)) {
    assertion(current && typeof current === "object" && !Array.isArray(current),
      "leaf pointer traverses a non-schema value");
    if (current.type === "object") {
      assertion(current.properties && Object.hasOwn(current.properties, segment),
        "leaf pointer is absent from the bound schema");
      current = current.properties[segment];
    } else if (current.type === "array") {
      assertion(segment === "*" || /^(?:0|[1-9][0-9]*)$/u.test(segment),
        "array leaf pointer segment is invalid");
      assertion(current.items && typeof current.items === "object", "array schema has no supported items schema");
      current = current.items;
    } else {
      fail("leaf pointer traverses an unsupported schema node");
    }
  }
  assertion(current && typeof current === "object" && !Array.isArray(current),
    "leaf schema is invalid");
  return current;
}

function valueMatchesSchema(value, schema, depth = 0) {
  if (depth > 24 || !schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  if (Array.isArray(schema.anyOf)) {
    // Schema admission permits only annotation siblings beside anyOf. Do not
    // silently bypass sibling validation constraints if that subset expands.
    return schema.anyOf.some(candidate => valueMatchesSchema(value, candidate, depth + 1));
  }
  if (Object.hasOwn(schema, "const")
    && canonicalWorkspaceJson(value) !== canonicalWorkspaceJson(schema.const)) return false;
  if (Array.isArray(schema.enum)
    && !schema.enum.some(item => canonicalWorkspaceJson(item) === canonicalWorkspaceJson(value))) return false;
  const type = schema.type;
  if (type === "null") return value === null;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") {
    if (typeof value !== "string") return false;
    const codePointLength = [...value].length;
    return (!Number.isSafeInteger(schema.minLength) || codePointLength >= schema.minLength)
      && (!Number.isSafeInteger(schema.maxLength) || codePointLength <= schema.maxLength)
      && (schema.format !== "date" || validCalendarDate(value));
  }
  if (type === "number" || type === "integer") {
    return typeof value === "number" && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))
      && (type !== "integer" || Number.isSafeInteger(value))
      && (typeof schema.minimum !== "number" || value >= schema.minimum)
      && (typeof schema.maximum !== "number" || value <= schema.maximum);
  }
  if (type === "array") {
    if (!Array.isArray(value)
      || (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems)
      || (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems)
      || !schema.items || !value.every(item => valueMatchesSchema(item, schema.items, depth + 1))) return false;
    if (schema.uniqueItems === true) {
      const canonical = value.map(canonicalWorkspaceJson);
      if (new Set(canonical).size !== canonical.length) return false;
    }
    if (Object.hasOwn(schema, "x-key")) {
      const keys = value.map(item => item?.[schema["x-key"]]);
      if (keys.some(key => typeof key !== "string") || new Set(keys).size !== keys.length) return false;
    }
    return true;
  }
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false
      && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
    if (Array.isArray(schema.required) && schema.required.some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) => !Object.hasOwn(properties, key)
      || valueMatchesSchema(item, properties[key], depth + 1));
  }
  return Object.hasOwn(schema, "const") || Array.isArray(schema.enum);
}

function validateWorkspaceIdentity(identity, documentMap, schemaBytes) {
  exactKeys(identity, [
    "contract", "workspace_id", "source", "schema", "document_map_sha256",
    "document_map_contract", "renderer", "chunk_policy_sha256", "leaf_obligations",
    "leaf_obligations_sha256", "workspace_policy", "workspace_policy_sha256",
    "genesis_transaction_id", "workspace_directory_name", "package_inclusion",
    "workspace_identity_sha256",
  ], "workspace identity");
  const { workspace_identity_sha256: digest, ...body } = identity;
  assertion(SHA256.test(digest ?? "") && sha256Canonical(body) === digest,
    "workspace identity digest does not replay");
  assertion(canonicalWorkspaceJson(identity.source) === canonicalWorkspaceJson(documentMap.bindings.source),
    "workspace source binding drifted");
  assertion(identity.schema.sha256 === sha256(schemaBytes)
    && canonicalWorkspaceJson(identity.schema) === canonicalWorkspaceJson(documentMap.bindings.schema),
  "workspace schema binding drifted");
  assertion(identity.document_map_sha256 === documentMap.document_map_sha256,
    "workspace document-map binding drifted");
  assertion(identity.chunk_policy_sha256 === documentMap.bindings.chunk_policy.sha256,
    "workspace chunk-policy binding drifted");
  assertion(identity.leaf_obligations_sha256 === sha256Canonical(identity.leaf_obligations),
    "workspace leaf inventory digest drifted");
  assertion(identity.package_inclusion === "enabled_experimental",
    "workspace package boundary drifted");
  return identity;
}

async function readAllEvents({ rootPath, workspaceId, workspaceIdentitySha256, generationSha256 }) {
  const events = [];
  let cursor = null;
  do {
    const page = await readExtractionWorkspacePage({
      rootPath,
      workspaceId,
      expectedWorkspaceIdentitySha256: workspaceIdentitySha256,
      collection: "events",
      limit: 100,
      cursor,
    });
    assertion(page.generation_sha256 === generationSha256, "workspace generation changed during verification");
    events.push(...page.items);
    assertion(events.length <= MAX_EVENTS, "workspace event count exceeds the verifier bound");
    cursor = page.next_cursor;
  } while (cursor !== null);
  return events;
}

function validateProposalEvent(event, workspaceIdentitySha256) {
  exactKeys(event, [
    "contract", "event_sequence", "kind", "workspace_identity_sha256", "leaf_pointer",
    "proposed_value", "chunk_ids", "verification", "event_id",
  ], "proposal event");
  assertion(event.contract?.name === "pdf-tools.verified-extraction-workspace-event"
    && event.contract?.version === "1.1.0-experimental" && event.kind === "proposal_submitted",
  "proposal event contract is unsupported");
  assertion(event.workspace_identity_sha256 === workspaceIdentitySha256,
    "proposal event workspace binding drifted");
  assertion(EVENT_ID.test(event.event_id ?? ""), "proposal event ID is invalid");
  const { event_id: eventId, ...body } = event;
  assertion(eventId === `event.${sha256Canonical(body)}`, "proposal event ID does not replay");
  assertion(canonicalWorkspaceJson(event.verification)
    === canonicalWorkspaceJson({ status: "unverified", reason: "not_replayed" }),
  "proposal event is not an unverified workspace proposal");
  assertion(Array.isArray(event.chunk_ids) && event.chunk_ids.length > 0
    && new Set(event.chunk_ids).size === event.chunk_ids.length
    && event.chunk_ids.every(item => CHUNK_ID.test(item)), "proposal chunk inventory is invalid");
  jsonValue(event.proposed_value);
  return event;
}

function normalizeCitations(citations, declaredChunkIds) {
  assertion(Array.isArray(citations) && citations.length >= 1 && citations.length <= MAX_CITATIONS,
    `citations must contain 1 through ${MAX_CITATIONS} entries`);
  const normalized = citations.map((citation, index) => {
    exactKeys(citation, ["chunk_id", "start_utf8_byte", "end_utf8_byte", "quote_sha256"],
      `citations[${index}]`);
    assertion(CHUNK_ID.test(citation.chunk_id ?? "") && declaredChunkIds.includes(citation.chunk_id),
      `citations[${index}] references an undeclared chunk`);
    assertion(Number.isSafeInteger(citation.start_utf8_byte) && citation.start_utf8_byte >= 0
      && Number.isSafeInteger(citation.end_utf8_byte)
      && citation.end_utf8_byte > citation.start_utf8_byte,
    `citations[${index}] byte range is invalid`);
    assertion(SHA256.test(citation.quote_sha256 ?? ""), `citations[${index}] quote digest is invalid`);
    return { ...citation };
  });
  assertion(new Set(normalized.map(canonicalWorkspaceJson)).size === normalized.length,
    "citations contain a duplicate entry");
  assertion(declaredChunkIds.every(chunkId => normalized.some(citation => citation.chunk_id === chunkId)),
    "proposal-declared chunk coverage is incomplete");
  return normalized;
}

function decodeExactUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} splits or contains invalid UTF-8`);
  }
}

function replayCitations({ citations, documentMap, sourceBytes, schemaBytes, layouts, chunkPolicy }) {
  const chunkCache = new Map();
  return citations.map(citation => {
    let chunk = chunkCache.get(citation.chunk_id);
    if (!chunk) {
      try {
        chunk = readSourceBoundDocumentChunk({
          documentMap,
          chunkId: citation.chunk_id,
          sourceBytes,
          schemaBytes,
          layouts,
          chunkPolicy,
        });
      } catch (error) {
        return { status: "chunk_missing", citation, error: error.message };
      }
      chunkCache.set(citation.chunk_id, chunk);
    }
    const contentBytes = Buffer.from(chunk.content, "utf8");
    if (citation.end_utf8_byte > contentBytes.length) {
      return { status: "citation_mismatch", citation, error: "citation exceeds the exact chunk bytes" };
    }
    let quote;
    try {
      quote = decodeExactUtf8(contentBytes.subarray(citation.start_utf8_byte, citation.end_utf8_byte),
        "citation range");
    } catch (error) {
      return { status: "citation_mismatch", citation, error: error.message };
    }
    if (sha256(Buffer.from(quote, "utf8")) !== citation.quote_sha256) {
      return { status: "citation_mismatch", citation, error: "citation quote digest drifted" };
    }
    return {
      status: "replayed",
      chunk_id: citation.chunk_id,
      page: chunk.page_range.start_page,
      start_utf8_byte: citation.start_utf8_byte,
      end_utf8_byte: citation.end_utf8_byte,
      quote,
      quote_sha256: citation.quote_sha256,
    };
  });
}

function normalizeProjection(quote, normalization) {
  if (normalization === "identity") return quote;
  if (normalization === "trim_ascii") return quote.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
  if (normalization === "collapse_ascii_whitespace") {
    return quote.replace(/[ \t\r\n]+/gu, " ").replace(/^ +| +$/gu, "");
  }
  if (normalization === "integer_ascii") {
    const text = quote.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
    assertion(/^-?(?:0|[1-9][0-9]*)$/u.test(text), "integer citation is not canonical ASCII");
    const value = Number(text);
    assertion(Number.isSafeInteger(value), "integer citation is outside the safe range");
    return value;
  }
  if (normalization === "decimal_ascii") {
    const text = quote.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
    assertion(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(text),
      "decimal citation is not canonical ASCII");
    decimalFraction(text, "decimal citation");
    return text;
  }
  fail("projection normalization is unsupported");
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function decimalFraction(value, label) {
  const text = typeof value === "number" ? JSON.stringify(value) : value;
  assertion(typeof text === "string" && text.length <= MAX_DECIMAL_DIGITS
    && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(text), `${label} is not a bounded decimal`);
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  let numerator = BigInt(`${negative ? "-" : ""}${whole}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return { numerator, denominator };
}

function combineFractions(left, right, operator) {
  let numerator;
  let denominator;
  if (operator === "sum") {
    numerator = left.numerator * right.denominator + right.numerator * left.denominator;
    denominator = left.denominator * right.denominator;
  } else if (operator === "difference") {
    numerator = left.numerator * right.denominator - right.numerator * left.denominator;
    denominator = left.denominator * right.denominator;
  } else if (operator === "product") {
    numerator = left.numerator * right.numerator;
    denominator = left.denominator * right.denominator;
  } else if (operator === "quotient") {
    assertion(right.numerator !== 0n, "calculation divides by zero");
    numerator = left.numerator * right.denominator;
    denominator = left.denominator * right.numerator;
    if (denominator < 0n) {
      numerator = -numerator;
      denominator = -denominator;
    }
  } else {
    fail("calculation operator is unsupported");
  }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function replayMethod(method, proposalValue, citations) {
  assertion(method && typeof method === "object" && !Array.isArray(method),
    "verification method must be an object");
  exactKeys(method, method.kind === "exact_projection"
    ? ["kind", "citation_index", "normalization"]
    : method.kind === "calculation"
      ? ["kind", "operator", "citation_indices", "input_normalization"]
      : method.kind === "source_supported"
        ? ["kind", "reason"]
        : method.kind === "ambiguous"
          ? ["kind", "reason", "alternative_count"]
          : method.kind === "unverified_reasoning"
            ? ["kind", "reason"]
            : ["kind"], "verification method");
  if (method.kind === "exact_projection") {
    assertion(Number.isSafeInteger(method.citation_index)
      && method.citation_index >= 0 && method.citation_index < citations.length,
    "projection citation index is invalid");
    const derived = normalizeProjection(citations[method.citation_index].quote, method.normalization);
    if (method.normalization === "decimal_ascii") {
      const source = decimalFraction(derived, "decimal citation");
      const proposed = decimalFraction(proposalValue, "proposed decimal value");
      const matches = source.numerator * proposed.denominator
        === proposed.numerator * source.denominator;
      return matches
        ? { status: "verified_exact", derived_value: proposalValue, calculation: null, reasons: [] }
        : { status: "citation_mismatch", derived_value: null, calculation: null,
          reasons: ["PROPOSED_VALUE_DOES_NOT_REPLAY"] };
    }
    return canonicalWorkspaceJson(derived) === canonicalWorkspaceJson(proposalValue)
      ? { status: "verified_exact", derived_value: derived, calculation: null, reasons: [] }
      : { status: "citation_mismatch", derived_value: derived, calculation: null,
        reasons: ["PROPOSED_VALUE_DOES_NOT_REPLAY"] };
  }
  if (method.kind === "calculation") {
    assertion(Array.isArray(method.citation_indices)
      && method.citation_indices.length >= 2
      && method.citation_indices.length <= MAX_CALCULATION_INPUTS
      && new Set(method.citation_indices).size === method.citation_indices.length
      && method.citation_indices.every(index => Number.isSafeInteger(index)
        && index >= 0 && index < citations.length), "calculation citation indices are invalid");
    assertion(method.input_normalization === "decimal_ascii",
      "calculation input normalization is unsupported");
    const inputs = method.citation_indices.map(index => {
      const text = citations[index].quote.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
      return { citation_index: index, text, fraction: decimalFraction(text, "calculation input") };
    });
    let result = inputs[0].fraction;
    for (const input of inputs.slice(1)) result = combineFractions(result, input.fraction, method.operator);
    const proposed = decimalFraction(proposalValue, "proposed calculation value");
    const matches = result.numerator * proposed.denominator === proposed.numerator * result.denominator;
    const calculation = {
      operator: method.operator,
      input_citation_indices: [...method.citation_indices],
      input_text_sha256: inputs.map(input => sha256(Buffer.from(input.text, "utf8"))),
      result_fraction: { numerator: result.numerator.toString(), denominator: result.denominator.toString() },
      input_selection_status: "unverified_reasoning",
    };
    return matches
      ? { status: "computed_with_inputs", derived_value: proposalValue, calculation, reasons: [] }
      : { status: "citation_mismatch", derived_value: null, calculation,
        reasons: ["CALCULATION_RESULT_DOES_NOT_MATCH_PROPOSAL"] };
  }
  if (method.kind === "source_supported") {
    assertion(typeof method.reason === "string" && method.reason.trim().length >= 1 && method.reason.length <= 500,
      "source-supported reason is invalid");
    return { status: "source_supported", derived_value: null, calculation: null,
      reasons: ["SEMANTIC_ASSIGNMENT_NOT_MECHANICALLY_PROVEN"] };
  }
  if (method.kind === "ambiguous") {
    assertion(typeof method.reason === "string" && method.reason.trim().length >= 1 && method.reason.length <= 500
      && Number.isSafeInteger(method.alternative_count) && method.alternative_count >= 2
      && method.alternative_count <= 1000, "ambiguity declaration is invalid");
    return { status: "ambiguous", derived_value: null, calculation: null,
      reasons: ["MULTIPLE_SOURCE_SUPPORTED_INTERPRETATIONS"] };
  }
  if (method.kind === "unverified_reasoning") {
    assertion(typeof method.reason === "string" && method.reason.trim().length >= 1 && method.reason.length <= 500,
      "unverified-reasoning declaration is invalid");
    return { status: "unverified_reasoning", derived_value: null, calculation: null,
      reasons: ["NO_ACCEPTED_DETERMINISTIC_VERIFIER"] };
  }
  fail("verification method is unsupported");
}

function completeSearchScope(documentMap) {
  return documentMap.chunks.omitted === 0
    && documentMap.chunks.omitted_content_utf8_bytes === 0
    && documentMap.chunks.omitted_admitted_item_references === 0
    && documentMap.coverage.accounted === true
    && documentMap.coverage.layout_omitted_items === 0
    && documentMap.coverage.layout_omitted_characters === 0
    && documentMap.coverage.unassigned_omitted_characters === 0
    && documentMap.pages.every(page => page.extraction_status === "complete"
      && page.needs_visual_inspection === false
      && page.chunk_counts.omitted === 0
      && page.chunk_counts.omitted_content_utf8_bytes === 0
      && page.chunk_counts.omitted_admitted_item_references === 0);
}

function retainedSearchScope(documentMap) {
  return {
    document_map_sha256: documentMap.document_map_sha256,
    returned_chunk_ids: documentMap.chunks.descriptors.map(item => item.chunk_id),
    chunks: {
      returned: documentMap.chunks.returned,
      omitted: documentMap.chunks.omitted,
      omitted_content_utf8_bytes: documentMap.chunks.omitted_content_utf8_bytes,
      omitted_admitted_item_references: documentMap.chunks.omitted_admitted_item_references,
    },
    coverage: {
      observed_pages: documentMap.coverage.observed_pages,
      accounted_pages: documentMap.coverage.accounted_pages,
      accounted: documentMap.coverage.accounted,
      layout_omitted_items: documentMap.coverage.layout_omitted_items,
      layout_omitted_characters: documentMap.coverage.layout_omitted_characters,
      unassigned_omitted_characters: documentMap.coverage.unassigned_omitted_characters,
    },
    pages: documentMap.pages.map(page => ({
      page: page.page,
      extraction_status: page.extraction_status,
      needs_visual_inspection: page.needs_visual_inspection,
      chunk_counts: {
        omitted: page.chunk_counts.omitted,
        omitted_content_utf8_bytes: page.chunk_counts.omitted_content_utf8_bytes,
        omitted_admitted_item_references: page.chunk_counts.omitted_admitted_item_references,
      },
    })),
  };
}

function validateRetainedSearchScope(scope, result) {
  exactKeys(scope, ["document_map_sha256", "returned_chunk_ids", "chunks", "coverage", "pages"],
    "verification search scope");
  assertion(scope.document_map_sha256 === result.document_map_sha256,
    "verification search scope document-map binding drifted");
  assertion(Array.isArray(scope.returned_chunk_ids) && scope.returned_chunk_ids.length > 0
    && scope.returned_chunk_ids.every(item => CHUNK_ID.test(item))
    && new Set(scope.returned_chunk_ids).size === scope.returned_chunk_ids.length,
  "verification search scope chunk inventory is invalid");
  exactKeys(scope.chunks, [
    "returned", "omitted", "omitted_content_utf8_bytes", "omitted_admitted_item_references",
  ], "verification search scope chunks");
  assertion(Number.isSafeInteger(scope.chunks.returned)
    && scope.chunks.returned === scope.returned_chunk_ids.length
    && [scope.chunks.omitted, scope.chunks.omitted_content_utf8_bytes,
      scope.chunks.omitted_admitted_item_references]
      .every(value => Number.isSafeInteger(value) && value === 0),
    "verification search scope contains omitted chunks or content");
  exactKeys(scope.coverage, [
    "observed_pages", "accounted_pages", "accounted", "layout_omitted_items", "layout_omitted_characters",
    "unassigned_omitted_characters",
  ], "verification search scope coverage");
  assertion(scope.coverage.accounted === true
    && Number.isSafeInteger(scope.coverage.observed_pages)
    && scope.coverage.observed_pages > 0
    && scope.coverage.accounted_pages === scope.coverage.observed_pages
    && scope.coverage.accounted_pages === scope.pages.length
    && scope.coverage.layout_omitted_items === 0
    && scope.coverage.layout_omitted_characters === 0
    && scope.coverage.unassigned_omitted_characters === 0,
  "verification search scope accounting is incomplete");
  assertion(Array.isArray(scope.pages) && scope.pages.length > 0,
    "verification search scope pages are invalid");
  const seenPages = new Set();
  for (const page of scope.pages) {
    exactKeys(page, ["page", "extraction_status", "needs_visual_inspection", "chunk_counts"],
      "verification search scope page");
    exactKeys(page.chunk_counts, [
      "omitted", "omitted_content_utf8_bytes", "omitted_admitted_item_references",
    ], "verification search scope page chunks");
    assertion(Number.isSafeInteger(page.page) && page.page >= 1 && !seenPages.has(page.page)
      && page.extraction_status === "complete" && page.needs_visual_inspection === false
      && Object.values(page.chunk_counts).every(value => Number.isSafeInteger(value) && value === 0),
    "verification search scope page is incomplete");
    seenPages.add(page.page);
  }
  assertion(scope.pages.every((page, index) => page.page === index + 1),
    "verification search scope page inventory is incomplete or unordered");
  assertion(canonicalWorkspaceJson([...scope.returned_chunk_ids].sort())
    === canonicalWorkspaceJson([...result.proposal_event.chunk_ids].sort()),
  "verification search scope does not match the proposal chunk inventory");
  return scope;
}

export async function verifyWorkspaceExtractionProposal({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
  expectedGenerationSha256,
  workspaceIdentity,
  proposalEventId,
  documentMap,
  sourceBytes,
  schemaBytes,
  layouts,
  citations,
  method,
  chunkPolicy = DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
}) {
  assertion(SHA256.test(expectedWorkspaceIdentitySha256 ?? ""),
    "expected workspace identity is invalid");
  assertion(SHA256.test(expectedGenerationSha256 ?? ""), "expected generation is invalid");
  assertion(EVENT_ID.test(proposalEventId ?? ""), "proposal event ID is invalid");
  validateSourceBoundDocumentMap(documentMap, { sourceBytes, schemaBytes, layouts, chunkPolicy });
  validateWorkspaceIdentity(workspaceIdentity, documentMap, Buffer.from(schemaBytes));
  assertion(workspaceIdentity.workspace_identity_sha256 === expectedWorkspaceIdentitySha256,
    "expected workspace identity drifted");
  const inspection = await inspectExtractionWorkspace({
    rootPath,
    workspaceId,
    expectedWorkspaceIdentitySha256,
  });
  assertion(inspection.state === "complete"
    && inspection.current_generation_sha256 === expectedGenerationSha256,
  "verification requires the exact complete current generation");
  const events = await readAllEvents({
    rootPath,
    workspaceId,
    workspaceIdentitySha256: expectedWorkspaceIdentitySha256,
    generationSha256: expectedGenerationSha256,
  });
  const proposals = events.filter(event => event.kind === "proposal_submitted")
    .map(event => validateProposalEvent(event, expectedWorkspaceIdentitySha256));
  const proposal = proposals.find(event => event.event_id === proposalEventId);
  assertion(proposal, "proposal event is absent from the exact workspace generation");
  assertion(workspaceIdentity.leaf_obligations.includes(proposal.leaf_pointer),
    "proposal leaf is absent from the workspace obligation inventory");
  const schema = parseSchema(Buffer.from(schemaBytes));
  const leafSchema = resolveSchemaLeaf(schema, proposal.leaf_pointer);
  assertion(valueMatchesSchema(proposal.proposed_value, leafSchema),
    "proposed value does not conform to the exact schema leaf");

  let replayedCitations = [];
  let replay;
  if (method?.kind === "not_found") {
    exactKeys(method, ["kind"], "verification method");
    assertion(Array.isArray(citations) && citations.length === 0,
      "not-found verification cannot include citations");
    assertion(proposal.proposed_value === null, "not-found proposal value must be null");
    const allReturnedChunkIds = documentMap.chunks.descriptors.map(item => item.chunk_id);
    assertion(canonicalWorkspaceJson([...proposal.chunk_ids].sort())
      === canonicalWorkspaceJson([...allReturnedChunkIds].sort()),
    "not-found proposal does not bind the complete returned chunk scope");
    assertion(completeSearchScope(documentMap), "not-found requires complete admitted search scope");
    // Complete coverage establishes what the caller could inspect, not what
    // they searched or whether the requested fact is absent from that source.
    replay = unverifiedAbsence();
  } else {
    const normalizedCitations = normalizeCitations(citations, proposal.chunk_ids);
    replayedCitations = replayCitations({
      citations: normalizedCitations,
      documentMap,
      sourceBytes,
      schemaBytes,
      layouts,
      chunkPolicy,
    });
    const failed = replayedCitations.find(item => item.status !== "replayed");
    replay = failed
      ? { status: failed.status, derived_value: null, calculation: null,
        reasons: [failed.error] }
      : replayMethod(method, proposal.proposed_value, replayedCitations);
  }

  const body = {
    contract: { ...EXTRACTION_PROPOSAL_VERIFIER },
    workspace_identity_sha256: expectedWorkspaceIdentitySha256,
    generation_sha256: expectedGenerationSha256,
    proposal_event_id: proposal.event_id,
    proposal_event: jsonValue(proposal),
    leaf_pointer: proposal.leaf_pointer,
    proposed_value: jsonValue(proposal.proposed_value),
    proposed_value_sha256: sha256Canonical(proposal.proposed_value),
    source: { ...documentMap.bindings.source },
    schema: { ...documentMap.bindings.schema },
    document_map_sha256: documentMap.document_map_sha256,
    chunk_policy_sha256: documentMap.bindings.chunk_policy.sha256,
    status: replay.status,
    reason_codes: replay.reasons,
    citations: replayedCitations,
    method: jsonValue(method),
    derived_value: replay.derived_value,
    calculation: replay.calculation,
    search_scope: method.kind === "not_found" ? retainedSearchScope(documentMap) : null,
    source_replayed: true,
    schema_replayed: true,
    caller_text_accepted_as_proof: false,
    caller_geometry_accepted_as_proof: false,
    caller_confidence_accepted_as_proof: false,
    table_topology_proven: false,
    claim_boundary: EXTRACTION_PROPOSAL_CLAIM_BOUNDARY,
    package_inclusion: "enabled_experimental",
  };
  return validateExtractionProposalVerificationResult({
    ...body,
    verification_sha256: sha256Canonical(body),
  });
}

export function validateExtractionProposalVerificationResult(result) {
  exactKeys(result, [
    "contract", "workspace_identity_sha256", "generation_sha256", "proposal_event_id",
    "proposal_event", "leaf_pointer", "proposed_value", "proposed_value_sha256", "source", "schema", "document_map_sha256",
    "chunk_policy_sha256", "status", "reason_codes", "citations", "method", "derived_value",
    "calculation", "search_scope", "source_replayed", "schema_replayed", "caller_text_accepted_as_proof",
    "caller_geometry_accepted_as_proof", "caller_confidence_accepted_as_proof",
    "table_topology_proven", "claim_boundary", "package_inclusion", "verification_sha256",
  ], "verification result");
  assertion(canonicalWorkspaceJson(result.contract) === canonicalWorkspaceJson(EXTRACTION_PROPOSAL_VERIFIER),
    "verification result contract is unsupported");
  assertion(EXTRACTION_PROPOSAL_STATUSES.includes(result.status), "verification status is unsupported");
  assertion(SHA256.test(result.workspace_identity_sha256 ?? "")
    && SHA256.test(result.generation_sha256 ?? "")
    && EVENT_ID.test(result.proposal_event_id ?? "")
    && typeof result.leaf_pointer === "string"
    && SHA256.test(result.proposed_value_sha256 ?? "")
    && SHA256.test(result.document_map_sha256 ?? "")
    && SHA256.test(result.chunk_policy_sha256 ?? ""),
  "verification result identities are invalid");
  validateProposalEvent(result.proposal_event, result.workspace_identity_sha256);
  assertion(result.proposal_event.event_id === result.proposal_event_id,
    "verification result proposal event binding drifted");
  assertion(result.proposal_event.leaf_pointer === result.leaf_pointer,
    "verification result proposal leaf drifted from its event");
  for (const [binding, label] of [[result.source, "source"], [result.schema, "schema"]]) {
    exactKeys(binding, ["sha256", "size_bytes"], `verification ${label}`);
    assertion(SHA256.test(binding.sha256 ?? "") && Number.isSafeInteger(binding.size_bytes)
      && binding.size_bytes > 0, `verification ${label} binding is invalid`);
  }
  assertion(Array.isArray(result.reason_codes)
    && result.reason_codes.every(reason => typeof reason === "string" && reason.length >= 1)
    && new Set(result.reason_codes).size === result.reason_codes.length,
  "verification reason codes are invalid");
  jsonValue(result.proposed_value);
  assertion(sha256Canonical(result.proposed_value) === result.proposed_value_sha256,
    "verification proposed value digest does not replay");
  assertion(canonicalWorkspaceJson(result.proposal_event.proposed_value)
    === canonicalWorkspaceJson(result.proposed_value),
  "verification proposed value drifted from its event");
  assertion(Array.isArray(result.citations) && result.citations.length <= MAX_CITATIONS,
    "verification citations are invalid");
  result.citations.forEach((citation, index) => {
    if (citation.status === "replayed") {
      exactKeys(citation, [
        "status", "chunk_id", "page", "start_utf8_byte", "end_utf8_byte", "quote", "quote_sha256",
      ], `verification citations[${index}]`);
      assertion(CHUNK_ID.test(citation.chunk_id ?? "") && Number.isSafeInteger(citation.page)
        && citation.page >= 1 && Number.isSafeInteger(citation.start_utf8_byte)
        && citation.start_utf8_byte >= 0 && Number.isSafeInteger(citation.end_utf8_byte)
        && citation.end_utf8_byte > citation.start_utf8_byte && typeof citation.quote === "string"
        && citation.end_utf8_byte - citation.start_utf8_byte
          === Buffer.byteLength(citation.quote, "utf8")
        && SHA256.test(citation.quote_sha256 ?? "")
        && sha256(Buffer.from(citation.quote, "utf8")) === citation.quote_sha256,
      `verification citations[${index}] replay is invalid`);
    } else {
      exactKeys(citation, ["status", "citation", "error"], `verification citations[${index}]`);
      assertion(["citation_mismatch", "chunk_missing"].includes(citation.status)
        && typeof citation.error === "string" && citation.error.length >= 1,
      `verification citations[${index}] failure is invalid`);
      exactKeys(citation.citation, ["chunk_id", "start_utf8_byte", "end_utf8_byte", "quote_sha256"],
        `verification citations[${index}].citation`);
      assertion(CHUNK_ID.test(citation.citation.chunk_id ?? "")
        && Number.isSafeInteger(citation.citation.start_utf8_byte)
        && citation.citation.start_utf8_byte >= 0
        && Number.isSafeInteger(citation.citation.end_utf8_byte)
        && citation.citation.end_utf8_byte > citation.citation.start_utf8_byte
        && SHA256.test(citation.citation.quote_sha256 ?? ""),
      `verification citations[${index}].citation is invalid`);
    }
  });
  const citationBindings = result.citations.map(citation => (
    citation.status === "replayed"
      ? {
        chunk_id: citation.chunk_id,
        start_utf8_byte: citation.start_utf8_byte,
        end_utf8_byte: citation.end_utf8_byte,
        quote_sha256: citation.quote_sha256,
      }
      : citation.citation
  ));
  assertion(new Set(citationBindings.map(canonicalWorkspaceJson)).size === citationBindings.length,
    "verification citations contain a duplicate binding");
  assertion(citationBindings.every(citation => result.proposal_event.chunk_ids.includes(citation.chunk_id)),
    "verification citation is absent from the proposal chunk inventory");
  assertion(result.method && typeof result.method === "object" && !Array.isArray(result.method),
    "verification method is invalid");
  const expectedMethodKeys = result.method.kind === "exact_projection"
    ? ["kind", "citation_index", "normalization"]
    : result.method.kind === "calculation"
      ? ["kind", "operator", "citation_indices", "input_normalization"]
      : result.method.kind === "source_supported"
        ? ["kind", "reason"]
        : result.method.kind === "ambiguous"
          ? ["kind", "reason", "alternative_count"]
          : result.method.kind === "unverified_reasoning"
            ? ["kind", "reason"]
            : result.method.kind === "not_found" ? ["kind"] : [];
  assertion(expectedMethodKeys.length > 0, "verification method kind is invalid");
  exactKeys(result.method, expectedMethodKeys, "verification method");
  jsonValue(result.method);
  if (result.method.kind === "exact_projection") {
    assertion(Number.isSafeInteger(result.method.citation_index)
      && result.method.citation_index >= 0 && result.method.citation_index < result.citations.length
      && ["identity", "trim_ascii", "collapse_ascii_whitespace", "integer_ascii", "decimal_ascii"]
        .includes(result.method.normalization), "verification projection method is invalid");
  } else if (result.method.kind === "calculation") {
    assertion(["sum", "difference", "product", "quotient"].includes(result.method.operator)
      && result.method.input_normalization === "decimal_ascii"
      && Array.isArray(result.method.citation_indices) && result.method.citation_indices.length >= 2
      && result.method.citation_indices.length <= MAX_CALCULATION_INPUTS
      && new Set(result.method.citation_indices).size === result.method.citation_indices.length
      && result.method.citation_indices.every(index => Number.isSafeInteger(index)
        && index >= 0 && index < result.citations.length), "verification calculation method is invalid");
  } else if (["source_supported", "unverified_reasoning"].includes(result.method.kind)) {
    assertion(typeof result.method.reason === "string" && result.method.reason.trim().length >= 1
      && result.method.reason.length <= 500, "verification semantic method is invalid");
  } else if (result.method.kind === "ambiguous") {
    assertion(typeof result.method.reason === "string" && result.method.reason.trim().length >= 1
      && result.method.reason.length <= 500 && Number.isSafeInteger(result.method.alternative_count)
      && result.method.alternative_count >= 2 && result.method.alternative_count <= 1000,
    "verification ambiguity method is invalid");
  }
  if (result.calculation !== null) {
    exactKeys(result.calculation, [
      "operator", "input_citation_indices", "input_text_sha256", "result_fraction",
      "input_selection_status",
    ], "verification calculation");
    exactKeys(result.calculation.result_fraction, ["numerator", "denominator"],
      "verification calculation fraction");
    assertion(["sum", "difference", "product", "quotient"].includes(result.calculation.operator)
      && Array.isArray(result.calculation.input_citation_indices)
      && result.calculation.input_citation_indices.length >= 2
      && result.calculation.input_citation_indices.every(Number.isSafeInteger)
      && Array.isArray(result.calculation.input_text_sha256)
      && result.calculation.input_text_sha256.length === result.calculation.input_citation_indices.length
      && result.calculation.input_text_sha256.every(digest => SHA256.test(digest))
      && /^-?(?:0|[1-9][0-9]*)$/u.test(result.calculation.result_fraction.numerator)
      && /^(?:[1-9][0-9]*)$/u.test(result.calculation.result_fraction.denominator)
      && result.calculation.input_selection_status === "unverified_reasoning",
    "verification calculation is invalid");
  }
  const allCitationsReplayed = result.citations.every(citation => citation.status === "replayed");
  const firstCitationFailure = result.citations.find(citation => citation.status !== "replayed") ?? null;
  if (result.status === "verified_exact") {
    assertion(result.method.kind === "exact_projection" && result.reason_codes.length === 0
      && allCitationsReplayed && result.citations.length >= 1 && result.calculation === null
      && result.derived_value !== null, "verified-exact result semantics are invalid");
  } else if (result.status === "computed_with_inputs") {
    assertion(result.method.kind === "calculation" && result.reason_codes.length === 0
      && allCitationsReplayed && result.citations.length >= 2 && result.calculation !== null
      && result.derived_value !== null, "computed result semantics are invalid");
  } else if (result.method.kind === "not_found") {
    assertion(result.status === "unverified_reasoning"
      && canonicalWorkspaceJson(result.reason_codes)
        === canonicalWorkspaceJson(unverifiedAbsence().reasons)
      && result.proposed_value === null && result.citations.length === 0
      && result.calculation === null && result.derived_value === null,
    "unverified absence result semantics are invalid");
  } else if (["source_supported", "ambiguous", "unverified_reasoning"].includes(result.status)) {
    const semanticReason = {
      source_supported: "SEMANTIC_ASSIGNMENT_NOT_MECHANICALLY_PROVEN",
      ambiguous: "MULTIPLE_SOURCE_SUPPORTED_INTERPRETATIONS",
      unverified_reasoning: "NO_ACCEPTED_DETERMINISTIC_VERIFIER",
    }[result.status];
    assertion(result.method.kind === result.status
      && canonicalWorkspaceJson(result.reason_codes) === canonicalWorkspaceJson([semanticReason])
      && allCitationsReplayed && result.citations.length >= 1 && result.calculation === null
      && result.derived_value === null, "semantic result semantics are invalid");
  } else {
    assertion(result.reason_codes.length === 1 && result.citations.length >= 1,
      "failed result reason semantics are invalid");
    if (result.status === "chunk_missing") {
      assertion(firstCitationFailure?.status === "chunk_missing"
        && result.derived_value === null && result.calculation === null,
      "chunk-missing result semantics are invalid");
    } else if (firstCitationFailure !== null) {
      assertion(firstCitationFailure.status === "citation_mismatch"
        && result.derived_value === null && result.calculation === null,
      "citation-failure result semantics are invalid");
    } else if (result.method.kind === "exact_projection") {
      assertion(canonicalWorkspaceJson(result.reason_codes)
        === canonicalWorkspaceJson(["PROPOSED_VALUE_DOES_NOT_REPLAY"])
        && result.calculation === null,
      "projection-mismatch result semantics are invalid");
    } else {
      assertion(result.method.kind === "calculation"
        && canonicalWorkspaceJson(result.reason_codes)
          === canonicalWorkspaceJson(["CALCULATION_RESULT_DOES_NOT_MATCH_PROPOSAL"])
        && result.derived_value === null && result.calculation !== null,
      "calculation-mismatch result semantics are invalid");
    }
  }
  if (result.method.kind === "not_found") {
    validateRetainedSearchScope(result.search_scope, result);
  } else {
    assertion(result.search_scope === null, "non-not-found result cannot retain a search scope");
    assertion(result.proposal_event.chunk_ids.every(chunkId => (
      citationBindings.some(citation => citation.chunk_id === chunkId)
    )), "verification citations do not cover the proposal chunk inventory");
  }
  const expectedReplay = result.method.kind === "not_found"
    ? unverifiedAbsence()
    : firstCitationFailure !== null
      ? { status: firstCitationFailure.status, derived_value: null, calculation: null,
        reasons: [firstCitationFailure.error] }
      : replayMethod(result.method, result.proposed_value, result.citations);
  assertion(canonicalWorkspaceJson({
    status: result.status,
    derived_value: result.derived_value,
    calculation: result.calculation,
    reasons: result.reason_codes,
  }) === canonicalWorkspaceJson(expectedReplay),
  "verification result semantics do not deterministically replay");
  jsonValue(result.derived_value);
  assertion(result.source_replayed === true && result.schema_replayed === true
    && result.caller_text_accepted_as_proof === false
    && result.caller_geometry_accepted_as_proof === false
    && result.caller_confidence_accepted_as_proof === false
    && result.table_topology_proven === false
    && result.claim_boundary === EXTRACTION_PROPOSAL_CLAIM_BOUNDARY
    && result.package_inclusion === "enabled_experimental",
  "verification claim boundary drifted");
  const { verification_sha256: digest, ...body } = result;
  assertion(SHA256.test(digest ?? "") && sha256Canonical(body) === digest,
    "verification result digest does not replay");
  return result;
}
