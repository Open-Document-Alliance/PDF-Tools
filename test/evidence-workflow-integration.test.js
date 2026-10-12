import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

for (const prefix of ["", "pdf-toolkit-mcp-share"]) {
  describe(`evidence workflow over MCP (${prefix || "source"})`, () => {
    it("batches, reviews, corrects, and refuses stale source or generation", async () => {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-evidence-wire-"));
      const docs = path.join(temporary, "documents");
      const home = path.join(temporary, "home");
      await fs.mkdir(docs);
      await fs.mkdir(home);
      const pdfPath = path.join(docs, "invoice.pdf");
      const source = await fs.readFile(path.join(ROOT, "test/fixtures/eval/extraction/synthetic/born-digital-flat.pdf"));
      await fs.writeFile(pdfPath, source);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(ROOT, prefix, "server/index.js")], cwd: ROOT,
        env: { HOME: home, PATH: process.env.PATH || "", ALLOWED_DIRECTORIES: docs,
          DEFAULT_PROFILES_DIR: path.join(home, "profiles") }, stderr: "ignore",
      });
      const client = new Client({ name: "evidence-workflow-regression", version: "1.0.0" });
      const call = async (name, args) => {
        const response = await client.callTool({ name, arguments: args });
        assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response)}`);
        assert.ok(response.structuredContent, `${name} must return structured content`);
        return response.structuredContent;
      };
      try {
        await client.connect(transport);
        const created = await call("create_extraction_workspace", {
          pdf_path: pdfPath, workspace_id: "invoice-review",
          schema: { type: "object", properties: { first: { type: "string" }, second: { type: "string" } } },
        });
        const bound = { workspace_id: "invoice-review", workspace_identity_sha256: created.workspace_identity_sha256 };
        const chunks = await call("read_extraction_workspace", { ...bound, collection: "document_map_chunks" });
        const chunk = await call("read_extraction_chunk", { ...bound, pdf_path: pdfPath, chunk_id: chunks.items[0].chunk_id });
        const quote = Buffer.from("INV-1001");
        const start = Buffer.from(chunk.content).indexOf(quote);
        assert.ok(start >= 0);
        const citations = [{ chunk_id: chunk.chunk_id, start_utf8_byte: start,
          end_utf8_byte: start + quote.length, quote_sha256: hash(quote) }];
        const method = { kind: "exact_projection", citation_index: 0, normalization: "identity" };
        const first = await call("submit_extraction_proposal", { ...bound,
          parent_generation_sha256: created.generation_sha256, leaf_pointer: "/first",
          proposed_value: "INV-1001", chunk_ids: [chunk.chunk_id] });
        const second = await call("submit_extraction_proposal", { ...bound,
          parent_generation_sha256: first.generation_sha256, leaf_pointer: "/second",
          proposed_value: "WRONG", chunk_ids: [chunk.chunk_id] });
        const batch = await call("verify_extraction_batch", { ...bound, pdf_path: pdfPath,
          parent_generation_sha256: second.generation_sha256,
          items: [first, second].map(proposal => ({ proposal_event_id: proposal.event.event_id, citations, method })),
        });
        assert.equal(batch.generation_sequence, second.generation_sequence + 1);
        assert.equal(batch.results.length, 2);
        assert.equal(batch.results[0].status, "verified_exact");
        assert.notEqual(batch.results[1].status, "verified_exact");
        const reviewArgs = { ...bound, pdf_path: pdfPath, expected_generation_sha256: batch.generation_sha256 };
        const review = await call("review_extraction_workspace", reviewArgs);
        assert.equal(review.extractionReview.source.sha256, hash(source));
        assert.equal(review.extractionReview.summary.settled, 1);
        assert.equal(review.extractionReview.summary.unresolved, 1);
        const history = await call("review_extraction_workspace", { ...reviewArgs, view: "history", leaf_pointer: "/second" });
        assert.equal(history.extractionReview.items[0].correction_allowed, true);
        assert.equal(history.extractionReview.items[0].citations[0].quote, "INV-1001");
        const corrected = await call("submit_extraction_proposal", { ...bound,
          parent_generation_sha256: batch.generation_sha256, leaf_pointer: "/second",
          proposed_value: "INV-1001", chunk_ids: [chunk.chunk_id] });
        const verified = await call("verify_extraction_proposal", { ...bound, pdf_path: pdfPath,
          proposal_generation_sha256: corrected.generation_sha256,
          proposal_event_id: corrected.event.event_id, citations, method });
        assert.equal(verified.result.status, "verified_exact");
        const stale = await client.callTool({ name: "review_extraction_workspace", arguments: reviewArgs });
        assert.equal(stale.isError, true);
        const refreshed = await call("review_extraction_workspace", { ...reviewArgs,
          expected_generation_sha256: verified.generation_sha256, view: "history", leaf_pointer: "/second" });
        assert.equal(refreshed.extractionReview.summary.settled, 2);
        assert.equal(refreshed.extractionReview.items.length, 2);
        assert.equal(refreshed.extractionReview.items[0].current, true);
        assert.equal(refreshed.extractionReview.items[1].current, false);
        assert.deepEqual(await fs.readFile(pdfPath), source);
        await fs.appendFile(pdfPath, "\n% external change\n");
        const changed = await client.callTool({ name: "review_extraction_workspace", arguments: {
          ...reviewArgs, expected_generation_sha256: verified.generation_sha256,
        } });
        assert.equal(changed.isError, true);
      } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        await fs.rm(temporary, { recursive: true, force: true });
      }
    }, 60_000);
  });
}
