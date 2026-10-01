#!/usr/bin/env node

// Exercise the actual contained plugin launcher and server, not a mocked UI.
// Only generated PDFs and isolated temporary state are used. Host save-back
// remains separately qualified through the built viewer/resource bridge.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";

const artifactRoot = await fs.realpath(path.resolve(process.argv[2] || "dist-plugin/pdf-tools"));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-host-import-artifact-"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const original = await PDFDocument.create();
original.addPage([420, 560]);
original.addPage([420, 560]);
const originalBytes = Buffer.from(await original.save());

async function withPlugin(name, extraEnv, work) {
  const home = path.join(temp, name, "home");
  await fs.mkdir(home, { recursive: true });
  const transport = new StdioClientTransport({
    command: path.join(artifactRoot, "bin", process.platform === "win32" ? "pdf-tools-launch.cmd" : "pdf-tools-launch"),
    args: [],
    cwd: artifactRoot,
    env: {
      PATH: process.env.PATH || path.dirname(process.execPath),
      HOME: home,
      PLUGIN_ROOT: artifactRoot,
      ...extraEnv,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "pdf-tools-synthetic-host-import-artifact", version: "1.0.0" });
  try { await client.connect(transport); return await work(client); }
  finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
}

try {
  const pluginData = path.join(temp, "success", "plugin-data");
  const success = await withPlugin("success", { PLUGIN_DATA: pluginData }, async client => {
    const { tools } = await client.listTools();
    const appOnly = tools.filter(tool => tool._meta?.ui?.visibility?.includes("app") && !tool._meta.ui.visibility.includes("model"));
    assert.equal(tools.length, 59);
    assert.equal(appOnly.length, 3);
    assert.equal(tools.length - appOnly.length, 56);
    const workspace = await client.callTool({ name: "open_pdf_workspace", arguments: {} });
    assert.deepEqual(workspace.structuredContent, { pdfWorkspace: { version: 1, state: "empty" } });

    const imported = await client.callTool({ name: "import_host_pdf", arguments: {
      pdf_base64: originalBytes.toString("base64"), display_name: "synthetic-artifact.pdf",
    } });
    assert.notEqual(imported.isError, true);
    const payload = imported.structuredContent;
    const workspaceRoot = await fs.realpath(path.join(pluginData, "workspace"));
    assert.equal(path.dirname(payload.active_path), workspaceRoot);
    assert.equal(payload.host_import.sha256, hash(originalBytes));
    assert.equal(payload.host_import.size_bytes, originalBytes.length);
    assert.deepEqual(await fs.readFile(payload.active_path), originalBytes);
    const identity = await client.callTool({ name: "get_pdf_identity", arguments: { pdf_path: payload.active_path } });
    assert.deepEqual(identity.structuredContent, payload.source);
    const editedPath = path.join(workspaceRoot, "synthetic-artifact-managed.pdf");
    const edited = await client.callTool({ name: "apply_page_plan", arguments: {
      input_path: payload.active_path, output_path: editedPath,
      plan: { page_order: [1, 2], rotations: { "1": 90 } },
    } });
    assert.notEqual(edited.isError, true);
    const canonicalEdited = await fs.realpath(editedPath);
    const bytes = await fs.readFile(canonicalEdited);
    const parsed = await PDFDocument.load(bytes);
    assert.equal(parsed.getPageCount(), 2);
    assert.equal(parsed.getPage(0).getRotation().angle, 90);
    assert.deepEqual(await fs.readFile(payload.active_path), originalBytes);
    const returned = await client.callTool({ name: "read_pdf_bytes", arguments: { pdf_path: canonicalEdited } });
    assert.notEqual(returned.isError, true);
    assert.deepEqual(Buffer.from(returned.structuredContent.bytes, "base64"), bytes);
    return { tools: tools.length, model_visible: tools.length - appOnly.length,
      tool_contract_sha256: hash(Buffer.from(JSON.stringify(tools))),
      original_sha256: hash(originalBytes), edited_sha256: hash(bytes), pages: parsed.getPageCount() };
  });

  const excludedData = path.join(temp, "excluded", "plugin-data");
  const allowed = path.join(temp, "excluded", "allowed");
  await fs.mkdir(allowed, { recursive: true });
  await withPlugin("excluded", { PLUGIN_DATA: excludedData, ALLOWED_DIRECTORIES: allowed }, async client => {
    const result = await client.callTool({ name: "import_host_pdf", arguments: { pdf_base64: originalBytes.toString("base64") } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error?.code, "HOST_IMPORT_WORKSPACE_UNAVAILABLE");
    await assert.rejects(fs.stat(path.join(excludedData, "workspace")), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(allowed), []);
  });
  console.log(JSON.stringify({ status: "pass", qualification: "contained_plugin_not_installed_chatgpt",
    runtime: process.version, ...success, excluded_folder_policy: "preserved", external_calls: 0 }, null, 2));
} finally {
  // The only deletion target is this invocation's mkdtemp-owned fixture root.
  await fs.rm(temp, { recursive: true, force: true });
}
