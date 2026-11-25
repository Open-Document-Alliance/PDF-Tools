import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { LUMIN_CONFIRMATION_STATEMENT, LUMIN_TOOL_NAMES } from "../remote/lumin-tools.mjs";
import { callTool, INSTRUCTIONS, listTools, SIGNING_INSTRUCTIONS } from "../remote/server.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const PREVIOUS = process.env.PDF_TOOLS_SIGN_SEALING_KEYS;
beforeAll(() => { process.env.PDF_TOOLS_SIGN_SEALING_KEYS = `t1:${"d".repeat(64)}`; });
afterAll(() => { if (PREVIOUS === undefined) delete process.env.PDF_TOOLS_SIGN_SEALING_KEYS; else process.env.PDF_TOOLS_SIGN_SEALING_KEYS = PREVIOUS; });

async function syntheticAgreement() {
  const doc = await PDFDocument.create();
  doc.setTitle("SYNTHETIC SIGNING TEST");
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Synthetic agreement for PDF Tools tests. No legal effect.", { x: 72, y: 720, size: 12, font });
  page.drawText("Signature:", { x: 72, y: 160, size: 12, font });
  return Buffer.from(await doc.save()).toString("base64");
}

const SIGNER = { participant_id: "signer-1", name: "Synthetic Signer", email_address: "synthetic.signer@example.com" };
const inHours = hours => new Date(Date.now() + hours * 3600_000).toISOString();
const plan = pdf_base64 => ({
  pdf_base64,
  title: "Synthetic signing test",
  expires_at: inHours(48),
  signers: [SIGNER],
  signature_locations: [{ participant_id: "signer-1", page: 1, x: 150, y: 610, width: 200, height: 40 }],
});

function fakeLumin(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  return { calls, context: token => ({ lumin: { accessToken: token, fetchImpl } }) };
}

const textOf = result => result.content[0].text;

describe("hosted Lumin tools are confined to the signing surface", () => {
  it("are neither listed nor callable on the public endpoint", async () => {
    const publicNames = listTools().tools.map(tool => tool.name);
    for (const name of LUMIN_TOOL_NAMES) expect(publicNames).not.toContain(name);
    const result = await callTool("send_lumin_request", { preparation_token: "x", confirmation_statement: "x", user_confirmed_at: new Date().toISOString() });
    expect(textOf(result)).toMatch(/^UNKNOWN_TOOL/);
  });

  it("are listed with titles on the signing surface", () => {
    const tools = listTools({ signing: true }).tools;
    expect(tools).toHaveLength(16);
    for (const name of LUMIN_TOOL_NAMES) {
      const tool = tools.find(candidate => candidate.name === name);
      expect(tool.annotations.title.length).toBeGreaterThan(0);
    }
    expect(tools.find(tool => tool.name === "send_lumin_request").annotations.destructiveHint).toBe(true);
  });

  it("keeps signing guidance out of the public instructions", () => {
    expect(INSTRUCTIONS).not.toMatch(/send_lumin_request/);
    expect(SIGNING_INSTRUCTIONS).toMatch(/exact statement/);
  });
});

describe("prepare_lumin_request", () => {
  it("draws the sign-here box, previews recipients and the exact confirmation, and sends nothing", async () => {
    const lumin = fakeLumin([]);
    const source = await syntheticAgreement();
    const result = await callTool("prepare_lumin_request", plan(source), lumin.context("synthetic-token"));
    expect(result.isError).toBeFalsy();
    expect(lumin.calls).toHaveLength(0);
    const content = result.structuredContent;
    expect(content.confirmation_statement_required).toBe(LUMIN_CONFIRMATION_STATEMENT);
    expect(textOf(result)).toContain("synthetic.signer@example.com");
    expect(textOf(result)).toContain("Nothing has been sent");
    expect(content.provider_execution_status).toBe("not_requested");
    expect(content.preparation_token).not.toContain("synthetic.signer");
    const prepared = await PDFDocument.load(Buffer.from(content.pdf_base64, "base64"));
    expect(prepared.getPageCount()).toBe(1);
    expect(content.output.sha256).toBe(sha256(Buffer.from(content.pdf_base64, "base64")));
  });

  it("is deterministic for the same source and plan", async () => {
    const lumin = fakeLumin([]);
    const source = await syntheticAgreement();
    const first = await callTool("prepare_lumin_request", plan(source), lumin.context("t"));
    const second = await callTool("prepare_lumin_request", plan(source), lumin.context("t"));
    expect(first.structuredContent.output.sha256).toBe(second.structuredContent.output.sha256);
  });

  it("refuses without a Lumin connection, plans without boxes for every signer, and boxes off the page", async () => {
    const source = await syntheticAgreement();
    expect(textOf(await callTool("prepare_lumin_request", plan(source), { lumin: { accessToken: "" } }))).toMatch(/^LUMIN_NOT_CONNECTED/);
    const two = { ...plan(source), signers: [SIGNER, { participant_id: "signer-2", name: "Second", email_address: "second@example.com" }] };
    expect(textOf(await callTool("prepare_lumin_request", two, fakeLumin([]).context("t")))).toMatch(/^INVALID_LOCATIONS/);
    const off = { ...plan(source), signature_locations: [{ participant_id: "signer-1", page: 1, x: 500, y: 700, width: 300, height: 200 }] };
    expect(textOf(await callTool("prepare_lumin_request", off, fakeLumin([]).context("t")))).toMatch(/^INVALID_LOCATIONS/);
    const soon = { ...plan(source), expires_at: inHours(0.5) };
    expect(textOf(await callTool("prepare_lumin_request", soon, fakeLumin([]).context("t")))).toMatch(/^INVALID_EXPIRY/);
  });
});

describe("send_lumin_request", () => {
  async function prepared() {
    const source = await syntheticAgreement();
    const result = await callTool("prepare_lumin_request", plan(source), fakeLumin([]).context("t"));
    return { source, token: result.structuredContent.preparation_token, previewSha: result.structuredContent.output.sha256 };
  }
  const confirmed = (source, token, extra = {}) => ({
    pdf_base64: source, preparation_token: token, confirmation_statement: LUMIN_CONFIRMATION_STATEMENT,
    user_confirmed_at: new Date().toISOString(), ...extra,
  });

  it("uploads exactly the previewed PDF once, with the PDF Tools User-Agent", async () => {
    const { source, token, previewSha } = await prepared();
    const lumin = fakeLumin([{ status: 201, body: { signature_request: { signature_request_id: "synthetic-req-1", status: "WAITING_FOR_PROCESSING", created_at: 1 } } }]);
    const result = await callTool("send_lumin_request", confirmed(source, token), lumin.context("synthetic-lumin-access"));
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ signature_request_id: "synthetic-req-1", attempt_count: 1, automatic_retry_performed: false });
    expect(lumin.calls).toHaveLength(1);
    const [call] = lumin.calls;
    expect(call.url).toBe("https://api.luminpdf.com/v1/signature_request/send");
    expect(call.init.redirect).toBe("error");
    expect(call.init.headers.authorization).toBe("Bearer synthetic-lumin-access");
    expect(call.init.headers["user-agent"]).toMatch(/^PDF-Tools\/\d+\.\d+\.\d+/);
    const form = call.init.body;
    expect(form.get("title")).toBe("Synthetic signing test");
    expect(form.get("signers[0][email_address]")).toBe("synthetic.signer@example.com");
    expect(form.get("use_text_tags")).toBe("true");
    expect(form.get("signing_type")).toBe("SAME_TIME");
    const file = [...form.values()].find(value => value instanceof Blob);
    expect(sha256(Buffer.from(await file.arrayBuffer()))).toBe(previewSha);
    expect(JSON.stringify(result)).not.toContain("synthetic-lumin-access");
  });

  it("refuses paraphrased, stale or future confirmations without contacting Lumin", async () => {
    const { source, token } = await prepared();
    const lumin = fakeLumin([]);
    expect(textOf(await callTool("send_lumin_request", confirmed(source, token, { confirmation_statement: "yes, send it" }), lumin.context("t")))).toMatch(/^CONFIRMATION_MISMATCH/);
    expect(textOf(await callTool("send_lumin_request", confirmed(source, token, { user_confirmed_at: new Date(Date.now() - 11 * 60_000).toISOString() }), lumin.context("t")))).toMatch(/^CONFIRMATION_STALE/);
    expect(textOf(await callTool("send_lumin_request", confirmed(source, token, { user_confirmed_at: new Date(Date.now() + 5 * 60_000).toISOString() }), lumin.context("t")))).toMatch(/^CONFIRMATION_STALE/);
    expect(textOf(await callTool("send_lumin_request", confirmed(source, token, { user_confirmed_at: new Date(Date.now() - 5 * 60_000).toISOString() }), lumin.context("t")))).toMatch(/^CONFIRMATION_BEFORE_PREVIEW/);
    expect(lumin.calls).toHaveLength(0);
  });

  it("refuses a different source document or a tampered preparation without contacting Lumin", async () => {
    const { token } = await prepared();
    const other = await syntheticAgreement();
    const doc = await PDFDocument.load(Buffer.from(other, "base64"));
    doc.addPage();
    const changed = Buffer.from(await doc.save()).toString("base64");
    const lumin = fakeLumin([]);
    expect(textOf(await callTool("send_lumin_request", confirmed(changed, token), lumin.context("t")))).toMatch(/^SOURCE_CHANGED/);
    const tampered = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(textOf(await callTool("send_lumin_request", confirmed(other, tampered), lumin.context("t")))).toMatch(/^PREPARATION_INVALID/);
    expect(lumin.calls).toHaveLength(0);
  });

  it("sends nothing when preparation used up the time budget, and says sending again is safe", async () => {
    const { source, token } = await prepared();
    const lumin = fakeLumin([]);
    const real = Date.now.bind(Date);
    const started = real();
    let calls = 0;
    // The handler reads the clock at its start; every later read is 35 s on, as if the fetch and preparation were slow.
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? started : started + 35_000));
    try {
      const result = await callTool("send_lumin_request", confirmed(source, token, { user_confirmed_at: new Date(started).toISOString() }), lumin.context("t"));
      expect(textOf(result)).toMatch(/^SEND_NOT_STARTED: .*safe/);
    } finally {
      spy.mockRestore();
    }
    expect(lumin.calls).toHaveLength(0);
  });

  it("reports rejected and unknown outcomes after exactly one attempt", async () => {
    for (const [response, code] of [
      [{ status: 400, body: { error: "bad" } }, "LUMIN_CREATE_REJECTED"],
      [new Error("network down"), "LUMIN_CREATE_OUTCOME_UNKNOWN"],
      [{ status: 201, body: { unexpected: true } }, "LUMIN_CREATE_OUTCOME_UNKNOWN"],
      [{ status: 502, body: { error: "bad gateway" } }, "LUMIN_CREATE_OUTCOME_UNKNOWN"],
      [{ status: 500, body: { error: "server" } }, "LUMIN_CREATE_OUTCOME_UNKNOWN"],
      [{ status: 409, body: { error: "conflict" } }, "LUMIN_CREATE_REJECTED"],
    ]) {
      const { source, token } = await prepared();
      const lumin = fakeLumin([response]);
      const result = await callTool("send_lumin_request", confirmed(source, token), lumin.context("t"));
      expect(textOf(result)).toMatch(new RegExp(`^${code}`));
      expect(lumin.calls).toHaveLength(1);
    }
  });
});

describe("check_lumin_status and download_lumin_artifact", () => {
  it("reads status for the named request only", async () => {
    const lumin = fakeLumin([{ status: 200, body: { signature_request: { signature_request_id: "synthetic-req-1", status: "NEED_TO_SIGN" } } }]);
    const result = await callTool("check_lumin_status", { signature_request_id: "synthetic-req-1" }, lumin.context("t"));
    expect(result.structuredContent).toEqual({ signature_request_id: "synthetic-req-1", status: "NEED_TO_SIGN" });
    expect(lumin.calls[0].url).toBe("https://api.luminpdf.com/v1/signature_request/synthetic-req-1");
    const mismatch = fakeLumin([{ status: 200, body: { signature_request: { signature_request_id: "other", status: "APPROVED" } } }]);
    expect(textOf(await callTool("check_lumin_status", { signature_request_id: "synthetic-req-1" }, mismatch.context("t")))).toMatch(/^LUMIN_STATUS_UNAVAILABLE/);
  });

  it("downloads through the public fetch guard and never returns the signed URL", async () => {
    const signed = Buffer.from(Buffer.from(await syntheticAgreement(), "base64"));
    const lumin = fakeLumin([{ status: 200, body: { signed_url: "https://files.example/synthetic.pdf?sig=SECRET", expires_at: Date.now() + 60_000 } }]);
    const context = lumin.context("t");
    context.lumin.artifactFetch = {
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response(signed, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(signed.length) } }),
    };
    const result = await callTool("download_lumin_artifact", { signature_request_id: "synthetic-req-1", file_type: "merged" }, context);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.output.sha256).toBe(sha256(signed));
    expect(lumin.calls[0].url).toBe("https://api.luminpdf.com/v1/signature_request/synthetic-req-1/file?type=merged");
    expect(JSON.stringify(result)).not.toContain("SECRET");

    context.lumin.artifactFetch = { lookupImpl: async () => [{ address: "10.0.0.5", family: 4 }] };
    const privateHost = fakeLumin([{ status: 200, body: { signed_url: "https://internal.example/x.pdf", expires_at: 1 } }]);
    const refused = await callTool("download_lumin_artifact", { signature_request_id: "synthetic-req-1", file_type: "merged" }, { lumin: { ...privateHost.context("t").lumin, artifactFetch: context.lumin.artifactFetch } });
    expect(refused.isError).toBe(true);
  });
});
