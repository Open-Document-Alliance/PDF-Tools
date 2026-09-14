import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathToPdfResourceUri } from "../server/resource-uri.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ROOT = process.env.PDF_TOOLS_SERVER_ROOT
  ? path.resolve(process.env.PDF_TOOLS_SERVER_ROOT)
  : REPO_ROOT;
const SERVER = process.env.PDF_TOOLS_SERVER_PATH
  ? path.resolve(process.env.PDF_TOOLS_SERVER_PATH)
  : path.join(SERVER_ROOT, "server", "index.js");
const SERVER_SOURCE = SERVER;
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const LEGACY_VERSION = "2025-11-25";
const MODERN_VERSION = "2026-07-28";
const UI_EXTENSION = "io.modelcontextprotocol/ui";
const UI_MIME = "text/html;profile=mcp-app";
const UI_URI = "ui://pdf-toolkit/viewer";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const RESOURCE_NOT_FOUND_MESSAGE = "PDF resource not found";
function stripModernCodecFields(result) {
  const {
    resultType: _resultType,
    ttlMs: _ttlMs,
    cacheScope: _cacheScope,
    _meta,
    ...parentResult
  } = result;
  const { [SERVER_INFO_META]: _serverInfo, ...parentMeta } = _meta ?? {};
  if (Object.keys(parentMeta).length > 0) parentResult._meta = parentMeta;
  return parentResult;
}

function promptArgs(prompt, fixturePdf) {
  return Object.fromEntries((prompt.arguments ?? []).map(argument => {
    let value = "sample";
    if (/pdf|path|file/i.test(argument.name)) value = fixturePdf;
    else if (/page|range/i.test(argument.name)) value = "1";
    return [argument.name, value];
  }));
}

function withTimeout(promise, label, timeoutMs = 10_000) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);
}

function clientCapabilities() {
  return {
    extensions: {
      [UI_EXTENSION]: {
        mimeTypes: [UI_MIME],
      },
    },
  };
}

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientInfo": {
      name: "pdf-tools-dual-era-test",
      version: "1.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": clientCapabilities(),
  };
}

function assertNoModernResultFields(result) {
  expect(result).not.toHaveProperty("resultType");
  expect(result).not.toHaveProperty("ttlMs");
  expect(result).not.toHaveProperty("cacheScope");
}

function assertModernComplete(result, { cacheable = false } = {}) {
  expect(result.resultType).toBe("complete");
  expect(result._meta?.[SERVER_INFO_META]).toEqual({
    name: "pdf-tools",
    version: "0.13.0",
  });
  if (cacheable) {
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe("private");
  } else {
    expect(result).not.toHaveProperty("ttlMs");
    expect(result).not.toHaveProperty("cacheScope");
  }
}

function startServer(stateRoot) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      ALLOWED_DIRECTORIES: stateRoot,
      DEFAULT_DOWNLOAD_DIR: stateRoot,
      DEFAULT_PDF_DIR: stateRoot,
      DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
      HOME: path.join(stateRoot, "home"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutMessages = [];
  const stderrLines = [];
  const pending = new Map();
  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes("\n")) {
      const newline = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
        throw error;
      }
      stdoutMessages.push(message);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id).resolve(message);
        pending.delete(message.id);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    while (stderrBuffer.includes("\n")) {
      const newline = stderrBuffer.indexOf("\n");
      const line = stderrBuffer.slice(0, newline);
      stderrBuffer = stderrBuffer.slice(newline + 1);
      if (line) stderrLines.push(line);
    }
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(message) {
    const response = new Promise((resolve, reject) => {
      pending.set(message.id, { resolve, reject });
    });
    send(message);
    return withTimeout(response, `response ${message.id}`);
  }

  async function close() {
    child.stdin.end();
    const exit = await withTimeout(
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      "server exit",
    );
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(stdoutBuffer.trim(), "");
    assert.equal(stderrBuffer.trim(), "");
    assert.ok(stdoutMessages.length > 0);
    assert.ok(stdoutMessages.every((message) => message?.jsonrpc === "2.0"));
    assert.equal(pending.size, 0);
    return { stderrLines, stdoutMessages };
  }

  return { child, close, request, send };
}

async function legacyInitialize(server, id = "legacy-initialize") {
  const response = await server.request({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_VERSION,
      capabilities: clientCapabilities(),
      clientInfo: {
        name: "pdf-tools-dual-era-test",
        version: "1.0.0",
      },
    },
  });
  expect(response.error).toBeUndefined();
  expect(response.result.protocolVersion).toBe(LEGACY_VERSION);
  assertNoModernResultFields(response.result);
  server.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  return response;
}

function legacyRequest(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

function modernRequest(id, method, params = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: modernMeta() },
  };
}

describe("MCP v2 dual-era stdio", () => {
  let stateRoot;
  let fixturePdf;
  const running = [];
  beforeEach(async () => {
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-dual-era-"));
    await fs.mkdir(path.join(stateRoot, "home"), { recursive: true });
    fixturePdf = path.join(stateRoot, "fixture.pdf");
    await fs.copyFile(EXAMPLE_PDF, fixturePdf);
  });
  afterEach(async () => {
    for (const server of running.splice(0)) {
      if (server.child.exitCode === null) server.child.kill();
    }
    await fs.rm(stateRoot, { recursive: true, force: true });
  });
  const start = root => { const server = startServer(root); running.push(server); return server; };

  it("preserves tools, prompts, PDF bytes and errors across both protocol eras", async () => {
    const legacy = start(stateRoot);
    const modern = start(stateRoot);
    await legacyInitialize(legacy);
    const discovery = await modern.request(modernRequest("discover", "server/discover"));
    expect(discovery.result.supportedVersions).toContain(MODERN_VERSION);
    expect(discovery.result.capabilities.extensions["io.modelcontextprotocol/skills"]).toEqual({});
    assertModernComplete(discovery.result, { cacheable: true });
    const pairs = [
      ["tools/list", {}], ["prompts/list", {}],
      ["tools/call", { name: "get_pdf_identity", arguments: { pdf_path: fixturePdf } }],
      ["resources/read", { uri: pathToPdfResourceUri(fixturePdf) }],
      ["resources/read", { uri: UI_URI }],
    ];
    const prompts = await legacy.request(legacyRequest("prompts", "prompts/list"));
    expect(prompts.result.prompts).toHaveLength(14);
    for (const prompt of prompts.result.prompts) pairs.push(["prompts/get", { name: prompt.name, arguments: promptArgs(prompt, fixturePdf) }]);
    for (const [i, [method, params]] of pairs.entries()) {
      const a = await legacy.request(legacyRequest("a" + i, method, params));
      const b = await modern.request(modernRequest("b" + i, method, params));
      expect(a.error).toBeUndefined(); expect(b.error).toBeUndefined();
      assertNoModernResultFields(a.result);
      assertModernComplete(b.result, { cacheable: method.endsWith("/list") || method === "resources/read" });
      expect(stripModernCodecFields(b.result)).toEqual(a.result);
      if (method === "tools/list") expect(a.result.tools).toHaveLength(57);
    }
    for (const uri of [pathToPdfResourceUri(path.join(stateRoot, "missing.pdf")), pathToPdfResourceUri("/not-allowed.pdf")]) {
      for (const [server, request] of [[legacy, legacyRequest], [modern, modernRequest]]) {
        const response = await server.request(request(uri, "resources/read", { uri }));
        expect(response.error).toEqual({ code: -32602, message: RESOURCE_NOT_FOUND_MESSAGE, data: { uri } });
      }
    }
    for (const method of ["tools/list", "prompts/list", "resources/list"]) {
      const response = await modern.request(modernRequest(method + "-cursor", method, { cursor: "unissued" }));
      expect(response.error.code).toBe(-32602);
    }
    const noEnvelope = await modern.request(legacyRequest("no-envelope", "tools/list"));
    expect(noEnvelope.error.code).toBe(-32602);
    await legacy.close(); await modern.close();
  });

  it("serves complete byte-exact skill manifests from the packaged allowlist", async () => {
    const server = start(stateRoot);
    await server.request(modernRequest("discover", "server/discover"));
    const list = await server.request(modernRequest("skills", "skills/list"));
    expect(list.error).toBeUndefined();
    expect(list.result).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
    expect(list.result.skills).toHaveLength(1);
    const skill = list.result.skills[0];
    expect(skill.uri).toBe("skill://pdf-tools-workflow/SKILL.md");
    expect(skill.resources).toHaveLength(2);
    const get = await server.request(modernRequest("get", "skills/get", { uri: skill.uri }));
    expect(get.result.skill).toEqual(skill);
    const again = await server.request(modernRequest("again", "skills/list"));
    expect(again.result).toEqual(list.result);
    const resources = await server.request(modernRequest("resources", "resources/list"));
    expect(resources.result.resources).toHaveLength(3);
    for (const resource of skill.resources) {
      expect(resources.result.resources.some(item => item.uri === resource.uri)).toBe(true);
      const read = await server.request(modernRequest(resource.uri, "resources/read", { uri: resource.uri }));
      const bytes = Buffer.from(read.result.contents[0].text, "utf8");
      expect(bytes.length).toBe(resource.size);
      expect("sha256:" + createHash("sha256").update(bytes).digest("hex")).toBe(resource.digest);
      const relative = resource.uri.slice("skill://pdf-tools-workflow/".length);
      const authored = await fs.readFile(path.join(REPO_ROOT, "plugins/pdf-tools-workflow/skills/pdf-tools-workflow", relative));
      expect(bytes).toEqual(authored);
      if (relative === "SKILL.md") {
        const yaml = await import("yaml");
        expect(yaml.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(bytes.toString())[1])).toEqual(skill.frontmatter);
      }
      assertModernComplete(read.result, { cacheable: true });
    }
    for (const uri of ["skill://pdf-tools-workflow/../SKILL.md", "skill://pdf-tools-workflow/%2e%2e/SKILL.md", "skill://pdf-tools-workflow/SKILL.md?x", "skill://pdf-tools-workflow/SKILL.md#x", "skill://other/SKILL.md"]) {
      for (const method of ["skills/get", "resources/read"]) {
        const response = await server.request(modernRequest(method + uri, method, { uri }));
        expect(response.error.code).toBe(-32602);
      }
    }
    for (const [method, params] of [["skills/list", { cursor: "unissued" }], ["skills/get", {}], ["skills/get", { uri: 12 }], ["skills/get", { uri: "file:///etc/passwd" }]]) {
      const response = await server.request(modernRequest(JSON.stringify(params), method, params));
      expect(response.error.code).toBe(-32602);
    }
    await server.close();
  });

  it("keeps legacy discovery unchanged and does not advertise native Skills", async () => {
    const server = start(stateRoot);
    const initialized = await legacyInitialize(server);
    expect(initialized.result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
    const resources = await server.request(legacyRequest("resources", "resources/list"));
    expect(resources.result.resources).toHaveLength(1);
    const skills = await server.request(legacyRequest("skills", "skills/list"));
    expect(skills.error.code).toBe(-32601);
    await server.close();
  });

  it("fills a synthetic form through modern MCP and independently reads back the saved bytes", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const source = path.join(stateRoot, "synthetic-form.pdf");
    const output = path.join(stateRoot, "filled-form.pdf");
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const field = doc.getForm().createTextField("sample_name");
    field.addToPage(page, { x: 20, y: 40, width: 180, height: 20 });
    const original = Buffer.from(await doc.save());
    await fs.writeFile(source, original);
    const server = start(stateRoot);
    await server.request(modernRequest("discover", "server/discover"));
    const response = await server.request(modernRequest("fill", "tools/call", {
      name: "fill_pdf",
      arguments: { pdf_path: source, field_data: { sample_name: "Synthetic Example" }, output_path: output },
    }));
    expect(response.error).toBeUndefined();
    expect(response.result.isError).not.toBe(true);
    const saved = await PDFDocument.load(await fs.readFile(output));
    expect(saved.getForm().getTextField("sample_name").getText()).toBe("Synthetic Example");
    expect(await fs.readFile(source)).toEqual(original);
    await server.close();
  });

  it("discards a modern probe and pins a usable legacy instance", async () => {
    const server = start(stateRoot);
    await server.request(modernRequest("discover", "server/discover"));
    await legacyInitialize(server);
    const tools = await server.request(legacyRequest("tools", "tools/list"));
    expect(tools.result.tools).toHaveLength(57);
    assertNoModernResultFields(tools.result);
    await server.close();
  });
});
