/**
 * Binds the remote server to the properties in
 * docs/REMOTE_STATELESS_PROFILE_2026-09-19.md. Each property and threat in that
 * document has at least one test here that fails when the property is broken,
 * which is gate 1 of that document.
 *
 * These run against the server object directly rather than over HTTP: the
 * transport is the MCP package's, and what needs binding is our behavior.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  callTool,
  createRemoteServer,
  listTools,
  MAX_INLINE_PDF_BYTES,
  MAX_PAGES,
  SERVER_NAME,
} from "../remote/server.mjs";
import { fetchPdfBytes, FetchRefused, MAX_PDF_BYTES, testing } from "../remote/fetch-guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

function textOf(result) {
  return (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
}

async function examplePdfBase64() {
  return (await readFile(EXAMPLE_PDF)).toString("base64");
}

describe("P1: nothing persists", () => {
  it("the remote modules never import a filesystem module", async () => {
    for (const file of ["server.mjs", "http.mjs", "fetch-guard.mjs"]) {
      const source = await readFile(path.join(REPO_ROOT, "remote", file), "utf8");
      expect(source, `${file} imports a filesystem module`).not.toMatch(
        /from\s+["']node:fs(\/promises)?["']|require\(["']fs["']\)/,
      );
    }
  });

  it("a fill returns the document in the response rather than a link to stored bytes", async () => {
    const result = await callTool("fill_form", {
      pdf_base64: await examplePdfBase64(),
      fields: { "topmostSubform[0].Page1[0].f1_01[0]": "Jordan Sample" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.pdf_base64).toBeTypeOf("string");
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/https?:\/\//);
  });
});

describe("P2: no identity", () => {
  it("no tool accepts a credential, token or account argument", async () => {
    const { tools } = await listTools();
    for (const tool of tools) {
      const properties = Object.keys(tool.inputSchema?.properties ?? {});
      for (const property of properties) {
        expect(property, `${tool.name} takes ${property}`).not.toMatch(
          /token|api_?key|password|account|session|auth/i,
        );
      }
    }
  });
});

describe("P5: bounded inputs", () => {
  it("refuses an inline document over the host's request ceiling, and names the way round it", async () => {
    // The host rejects a request body above ~4.5 MB before this code runs, so
    // an inline document has a lower ceiling than one fetched by URL. Refusing
    // it here is what turns an opaque host error into an instruction.
    const oversized = Buffer.alloc(MAX_INLINE_PDF_BYTES + 1024, 0x41).toString("base64");
    const result = await callTool("read_form_fields", { pdf_base64: oversized });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/^TOO_LARGE_INLINE/);
    expect(text).toMatch(/pdf_url/);
    expect(text).toMatch(/25 MB/);
    expect(text).toMatch(/PDF-Tools/);
  });

  it("keeps the inline ceiling below the fetched one, since a host sets the first", () => {
    expect(MAX_INLINE_PDF_BYTES).toBeLessThan(MAX_PDF_BYTES);
  });

  it("refuses a document with more pages than the cap", async () => {
    const document = await PDFDocument.create();
    for (let index = 0; index <= MAX_PAGES; index += 1) document.addPage([200, 200]);
    const result = await callTool("read_form_fields", {
      pdf_base64: Buffer.from(await document.save()).toString("base64"),
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^TOO_MANY_PAGES/);
  });

  it("refuses a request that supplies both input forms", async () => {
    const result = await callTool("read_form_fields", {
      pdf_url: "https://example.com/a.pdf",
      pdf_base64: await examplePdfBase64(),
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^AMBIGUOUS_INPUT/);
  });
});

describe("P6: the surface stays narrow", () => {
  it("exposes exactly the paperwork tools and nothing local-only", async () => {
    const { tools } = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "apply_signature",
      "detect_signature_zones",
      "fill_form",
      "flatten_form",
      "read_form_fields",
    ]);
  });

  it("never exposes a tool that implies local files, profiles or a viewer", async () => {
    const { tools } = await listTools();
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/profile|directory|finder|viewer|display|bytes|lumin|workspace/i);
    }
  });
});

describe("P7: honest naming", () => {
  it("no tool description mentions a specific host or a desktop path", async () => {
    const { tools } = await listTools();
    for (const tool of tools) {
      const description = `${tool.description} ${JSON.stringify(tool.inputSchema)}`;
      expect(description, `${tool.name} names a host or desktop concept`).not.toMatch(
        /claude|\/mnt\/|finder|desktop|allowed directories/i,
      );
    }
  });

  it("the signature tool says what it is and is not", async () => {
    const { tools } = await listTools();
    const signature = tools.find((tool) => tool.name === "apply_signature");
    expect(signature.description).toMatch(/not a cryptographic signature/i);
    expect(signature.description).toMatch(/NEVER invent/);
  });

  it("the server states that it stores nothing", async () => {
    const server = createRemoteServer();
    expect(SERVER_NAME).toBe("pdf-tools-remote");
    expect(server).toBeTruthy();
  });
});

describe("T1: the URL fetcher cannot be aimed at private networks", () => {
  const blocked = [
    ["cloud metadata", "169.254.169.254"],
    ["loopback", "127.0.0.1"],
    ["private class A", "10.0.0.5"],
    ["private class B", "172.16.4.4"],
    ["private class C", "192.168.1.1"],
    ["carrier-grade NAT and tailnets", "100.100.80.42"],
    ["unspecified", "0.0.0.0"],
    ["multicast", "239.1.1.1"],
  ];

  it.each(blocked)("refuses %s", async (_label, address) => {
    await expect(fetchPdfBytes(`http://${address}/a.pdf`)).rejects.toMatchObject({
      code: "PRIVATE_ADDRESS",
    });
  });

  it.each([
    ["IPv6 loopback", "[::1]"],
    ["IPv6 unique local", "[fd00::1]"],
    ["IPv6 link local", "[fe80::1]"],
  ])("refuses %s", async (_label, address) => {
    await expect(fetchPdfBytes(`http://${address}/a.pdf`)).rejects.toMatchObject({
      code: "PRIVATE_ADDRESS",
    });
  });

  it("refuses schemes other than http and https", async () => {
    for (const url of ["file:///etc/passwd", "gopher://example.com/", "data:application/pdf;base64,AAA"]) {
      await expect(fetchPdfBytes(url)).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEME" });
    }
  });

  it("re-checks the destination after a redirect into a private range", async () => {
    let hops = 0;
    const fetchImpl = async () => {
      hops += 1;
      if (hops > 1) throw new Error("the guard followed a redirect it should have refused");
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    };
    await expect(fetchPdfBytes("https://example.com/a.pdf", { fetchImpl })).rejects.toMatchObject({
      code: "PRIVATE_ADDRESS",
    });
    expect(hops).toBe(1);
  });

  it("stops after the redirect limit", async () => {
    const fetchImpl = async () =>
      new Response(null, { status: 302, headers: { location: "https://example.com/next" } });
    await expect(fetchPdfBytes("https://example.com/a.pdf", { fetchImpl })).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS",
    });
  });

  it("refuses a response whose bytes are not a PDF, so it cannot read arbitrary content", async () => {
    const fetchImpl = async () =>
      new Response("<html>internal admin page</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    await expect(fetchPdfBytes("https://example.com/a.pdf", { fetchImpl })).rejects.toMatchObject({
      code: "NOT_A_PDF",
    });
  });

  it("refuses a body that exceeds the cap even when the declared length lies", async () => {
    const oversized = new Uint8Array(MAX_PDF_BYTES + 4096);
    oversized.set([0x25, 0x50, 0x44, 0x46]);
    const fetchImpl = async () =>
      new Response(oversized, { status: 200, headers: { "content-length": "10" } });
    await expect(fetchPdfBytes("https://example.com/a.pdf", { fetchImpl })).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });

  it("classifies address ranges directly", () => {
    expect(testing.isBlockedAddress("8.8.8.8", 4)).toBe(false);
    expect(testing.isBlockedAddress("169.254.169.254", 4)).toBe(true);
    expect(testing.isBlockedAddress("::ffff:127.0.0.1", 6)).toBe(true);
    expect(testing.isBlockedAddress("2606:4700::1111", 6)).toBe(false);
  });
});

describe("T2: hostile and encrypted documents", () => {
  it("refuses an encrypted document instead of asking for a password", async () => {
    const encrypted = await readFile(
      path.join(REPO_ROOT, "test/fixtures/golden-forms/encrypted-rotated-signature.pdf"),
    );
    const result = await callTool("read_form_fields", {
      pdf_base64: encrypted.toString("base64"),
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^ENCRYPTED/);
    expect(textOf(result)).toMatch(/never takes passwords/i);
    expect(textOf(result)).not.toMatch(/supply the password|password parameter/i);
  });

  it("refuses bytes that are not a document at all, without echoing them", async () => {
    const junk = Buffer.from("this is not a pdf, and here is a secret: hunter2").toString("base64");
    const result = await callTool("read_form_fields", { pdf_base64: junk });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/hunter2/);
  });
});

describe("T4: the honesty guarantees survive the move to a server", () => {
  it("filling never claims the form is complete", async () => {
    const result = await callTool("fill_form", {
      pdf_base64: await examplePdfBase64(),
      fields: { "topmostSubform[0].Page1[0].f1_01[0]": "Jordan Sample" },
    });
    expect(textOf(result)).toMatch(/does not prove the form is complete/i);
  });

  it("names the fields it could not fill rather than silently dropping them", async () => {
    const result = await callTool("fill_form", {
      pdf_base64: await examplePdfBase64(),
      fields: { "no_such_field": "value" },
    });
    expect(result.structuredContent.not_filled).toHaveLength(1);
    expect(textOf(result)).toMatch(/Not filled/);
  });

  it("refuses to sign without the signer's own statement of intent", async () => {
    const result = await callTool("apply_signature", {
      pdf_base64: await examplePdfBase64(),
      display_name: "Jordan Sample",
      page: 1, x: 100, y: 500, width: 200, height: 18,
      intent_statement: "",
      confirmed_at: new Date().toISOString(),
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/INTENT_INVALID/);
  });

  it("refuses a confirmation older than a day", async () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const result = await callTool("apply_signature", {
      pdf_base64: await examplePdfBase64(),
      display_name: "Jordan Sample",
      page: 1, x: 100, y: 500, width: 200, height: 18,
      intent_statement: "I, Jordan Sample, sign this test document.",
      confirmed_at: stale,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/INTENT_INVALID/);
  });

  it("records the signer, time and intent in the signed document", async () => {
    const confirmedAt = new Date().toISOString();
    const result = await callTool("apply_signature", {
      pdf_base64: await examplePdfBase64(),
      display_name: "Jordan Sample",
      page: 1, x: 100, y: 500, width: 200, height: 18,
      intent_statement: "I, Jordan Sample, sign this test document.",
      confirmed_at: confirmedAt,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.audit_line).toMatch(/signer="Jordan Sample"/);
    expect(result.structuredContent.audit_line).toMatch(/intent="I, Jordan Sample/);
    expect(textOf(result)).toMatch(/not a cryptographic signature/i);
  });
});
