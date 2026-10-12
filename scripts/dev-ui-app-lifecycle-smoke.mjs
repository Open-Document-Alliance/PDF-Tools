import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  createAgentBrowserSessionRunner,
  evalJson,
} from "./dev-ui-smoke-helpers.mjs";

const repoRoot = process.cwd();
const requestedPort = Number(process.env.PDF_TOOLS_APP_LIFECYCLE_PORT || 0);
let origin = "";
const session = `pdf-tools-app-lifecycle-${Date.now()}`;
const runAgentBrowser = createAgentBrowserSessionRunner(session);
const viewerHtml = await fs.readFile(path.join(repoRoot, "dist-ui", "index.html"));

async function createLifecycleFixture() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const firstPage = document.addPage([612, 792]);
  firstPage.drawText("Synthetic text fixture marker: BLUEHARBOR-TEXT-20260721", {
    x: 72,
    y: 680,
    size: 18,
    font,
    color: rgb(0.05, 0.2, 0.65),
  });
  firstPage.drawText("PDF Tools built-viewer lifecycle qualification", {
    x: 72,
    y: 640,
    size: 14,
    font,
  });
  const secondPage = document.addPage([612, 792]);
  secondPage.drawText("Marker: BLUEHARBOR-PAGE-TWO", {
    x: 72,
    y: 680,
    size: 18,
    font,
  });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

const fixtureBytes = await createLifecycleFixture();

function hostHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>PDF Tools MCP Apps lifecycle host</title>
  <style>
    html, body { margin: 0; min-height: 100%; background: #eee; }
    iframe { width: 1000px; height: 900px; border: 0; background: white; }
  </style>
</head>
<body>
  <main id="frame-root"></main>
  <script>
    (() => {
      const state = {
        resourceLoads: 0,
        initializeCount: 0,
        initializeContractErrors: [],
        initializedCount: 0,
        initialToolInputs: 0,
        initialToolResults: 0,
        readBytesCalls: 0,
        invalidReadBytesCalls: 0,
        maxReadByteCount: 0,
        setActiveDocumentCalls: 0,
        modelContextCalls: 0,
        sizeChanges: [],
        displayModeRequests: [],
        teardownRequests: 0,
        teardownAcks: 0,
        protocolErrorsSent: 0,
        heldReadRequests: 0,
        releasedReadRequests: 0,
        detectZoneCalls: 0,
        listSignatureCalls: 0,
        applyTextCalls: 0,
        createSignatureCalls: 0,
        applySignatureCalls: 0,
        heldApplyTextRequests: 0,
        releasedApplyTextRequests: 0,
        heldCreateSignatureRequests: 0,
        releasedCreateSignatureRequests: 0,
        postAckMessages: 0,
        teardownError: null,
      };
      let frame = null;
      let fixture = null;
      let nextHostRequestId = 10000;
      const pendingHostRequests = new Map();
      const heldReadRequests = [];
      const heldApplyTextRequests = [];
      const heldCreateSignatureRequests = [];
      let holdReads = false;
      let holdApplyText = false;
      let holdCreateSignature = false;
      let detectedZoneType = "date";
      let monitorPostAckMessages = false;
      let initialDeliveryMode = "content-only";

      const fixturePromise = fetch("/fixture.pdf")
        .then(response => {
          if (!response.ok) throw new Error("Fixture fetch failed: " + response.status);
          state.resourceLoads++;
          return response.arrayBuffer();
        })
        .then(buffer => {
          fixture = new Uint8Array(buffer);
          return fixture;
        });

      function send(message) {
        frame?.contentWindow?.postMessage(message, "*");
      }

      function reply(id, result) {
        send({ jsonrpc: "2.0", id, result });
      }

      function replyError(id, code, message) {
        send({ jsonrpc: "2.0", id, error: { code, message } });
      }

      function encodeBase64(bytes) {
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
      }

      async function sendInitialToolResult() {
        const bytes = await fixturePromise;
        if (initialDeliveryMode !== "content-only-no-input") {
          const inputPdfPath = initialDeliveryMode === "stale-input-mismatch"
            ? "/fixtures/stale-artifact.pdf"
            : "/fixtures/lifecycle.pdf";
          state.initialToolInputs++;
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: {
              arguments: {
                pdf_path: inputPdfPath,
                page: 1,
              },
            },
          });
          if (initialDeliveryMode === "interleaved-input-result") {
            state.initialToolInputs++;
            send({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-input",
              params: {
                arguments: {
                  pdf_path: "/fixtures/interleaved-artifact.pdf",
                  page: 1,
                },
              },
            });
          }
        }
        state.initialToolResults++;
        const content = [{
          type: "text",
          text: "Displaying: lifecycle.pdf (" + Math.ceil(bytes.length / 1024) + " KB)",
        }];
        if (initialDeliveryMode === "error") {
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
              content: [{ type: "text", text: "The requested PDF could not be opened." }],
              isError: true,
            },
          });
          return;
        }
        if (initialDeliveryMode === "unrecognized") {
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
              content: [{ type: "text", text: "Saved a new PDF file." }],
            },
          });
          return;
        }
        if (initialDeliveryMode === "conflict") {
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
              content,
              structuredContent: {
                pdfPath: "/fixtures/lifecycle.pdf",
                totalBytes: bytes.length,
                initialPage: 1,
              },
              _meta: {
                pdfPath: "/fixtures/conflicting.pdf",
                totalBytes: bytes.length + 1,
                initialPage: 1,
              },
            },
          });
          return;
        }
        if (initialDeliveryMode === "partial-mismatch") {
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
              content,
              _meta: {
                pdfPath: "/fixtures/conflicting.pdf",
              },
            },
          });
          return;
        }
        if (
          initialDeliveryMode === "content-only" ||
          initialDeliveryMode === "content-only-no-input" ||
          initialDeliveryMode === "content-only-duplicate" ||
          initialDeliveryMode === "stale-input-mismatch" ||
          initialDeliveryMode === "interleaved-input-result"
        ) {
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: { content },
          });
          if (initialDeliveryMode === "content-only-duplicate") {
            state.initialToolResults++;
            send({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: { content },
            });
          }
          return;
        }
        const params = {
          content,
          structuredContent: {
            pdfPath: "/fixtures/lifecycle.pdf",
            totalBytes: bytes.length,
            initialPage: 1,
          },
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            pdfPath: "/fixtures/lifecycle.pdf",
            totalBytes: bytes.length,
            initialPage: 1,
          },
        };
        send({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params,
        });
        if (initialDeliveryMode === "full-duplicate") {
          state.initialToolResults++;
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params,
          });
        }
      }

      async function replyToReadRequest(message) {
        const bytes = await fixturePromise;
        const args = message.params.arguments || {};
        const requestedOffset = Number(args.offset);
        const requestedByteCount = Number(args.byteCount);
        if (
          !Number.isSafeInteger(requestedOffset) ||
          requestedOffset < 0 ||
          !Number.isSafeInteger(requestedByteCount) ||
          requestedByteCount <= 0 ||
          requestedByteCount > 524288
        ) {
          state.invalidReadBytesCalls++;
        }
        state.maxReadByteCount = Math.max(
          state.maxReadByteCount,
          Number.isFinite(requestedByteCount) ? requestedByteCount : 0,
        );
        const begin = Math.max(0, Number(args.offset) || 0);
        const end = Math.min(bytes.length, begin + Math.max(0, Number(args.byteCount) || 0));
        state.readBytesCalls++;
        reply(message.id, {
          content: [{ type: "text", text: "Read PDF bytes." }],
          structuredContent: {
            pdfPath: args.pdf_path,
            bytes: encodeBase64(bytes.subarray(begin, end)),
            totalBytes: bytes.length,
            offset: begin,
            byteCount: end - begin,
          },
        });
      }

      async function handleRequest(message) {
        switch (message.method) {
          case "ui/initialize":
            state.initializeCount++;
            if (message.params.protocolVersion !== "2026-01-26") {
              state.initializeContractErrors.push("protocolVersion");
            }
            if (
              message.params.appInfo?.name !== "PDF Tools Viewer" ||
              message.params.appInfo?.version !== "1.0.0"
            ) {
              state.initializeContractErrors.push("appInfo");
            }
            if (JSON.stringify(message.params.appCapabilities) !== "{}") {
              state.initializeContractErrors.push("appCapabilities");
            }
            if (state.initializeContractErrors.length > 0) {
              replyError(message.id, -32602, "Unexpected ui/initialize contract.");
              return;
            }
            reply(message.id, {
              protocolVersion: "2026-01-26",
              hostInfo: {
                name: "pdf-tools-built-lifecycle-host",
                version: "1.0.0",
              },
              hostCapabilities: {
                serverTools: {},
                serverResources: {},
                updateModelContext: { text: {} },
              },
              hostContext: {
                theme: "light",
                styles: {
                  variables: {
                    "--color-background-primary": "rgb(250, 250, 250)",
                  },
                },
                displayMode: "inline",
                availableDisplayModes: ["inline", "fullscreen"],
                platform: "desktop",
              },
            });
            return;
          case "tools/call": {
            const name = message.params.name;
            if (name === "read_pdf_bytes") {
              if (holdReads) {
                state.heldReadRequests++;
                heldReadRequests.push(message);
                return;
              }
              await replyToReadRequest(message);
              return;
            }
            if (name === "set_active_document") {
              state.setActiveDocumentCalls++;
              reply(message.id, {
                content: [{ type: "text", text: "Active document updated." }],
              });
              return;
            }
            if (name === "detect_signature_zones") {
              state.detectZoneCalls++;
              const type = detectedZoneType;
              reply(message.id, {
                content: [{ type: "text", text: "Detected one lifecycle test zone." }],
                structuredContent: {
                  zones: [{
                    type,
                    label: type === "date" ? "Lifecycle date" : "Lifecycle signature",
                    page: 1,
                    x: 72,
                    y: 96,
                    width: 160,
                    height: 28,
                    confidence: 1,
                    source: "lifecycle-smoke",
                  }],
                  warnings: [],
                },
              });
              return;
            }
            if (name === "list_signatures") {
              state.listSignatureCalls++;
              reply(message.id, {
                content: [{ type: "text", text: "No saved signatures." }],
                structuredContent: { signatures: [] },
              });
              return;
            }
            if (name === "apply_text") {
              state.applyTextCalls++;
              if (holdApplyText) {
                state.heldApplyTextRequests++;
                heldApplyTextRequests.push(message);
                return;
              }
              reply(message.id, {
                content: [{ type: "text", text: "Applied date text." }],
                structuredContent: {
                  pdf_path: "/fixtures/lifecycle.pdf",
                  backup_path: "/fixtures/lifecycle.backup.pdf",
                },
              });
              return;
            }
            if (name === "create_signature") {
              state.createSignatureCalls++;
              if (holdCreateSignature) {
                state.heldCreateSignatureRequests++;
                heldCreateSignatureRequests.push(message);
                return;
              }
              reply(message.id, {
                content: [{ type: "text", text: "Created lifecycle signature." }],
                structuredContent: { name: "__pdf-tools-quick-typed__" },
              });
              return;
            }
            if (name === "apply_signature") {
              state.applySignatureCalls++;
              reply(message.id, {
                content: [{ type: "text", text: "Applied lifecycle signature." }],
                structuredContent: {
                  pdf_path: "/fixtures/lifecycle.pdf",
                  backup_path: "/fixtures/lifecycle.backup.pdf",
                },
              });
              return;
            }
            replyError(message.id, -32601, "Unsupported test tool: " + name);
            return;
          }
          case "ui/update-model-context":
            state.modelContextCalls++;
            reply(message.id, {});
            return;
          case "ui/request-display-mode":
            state.displayModeRequests.push(message.params.mode);
            reply(message.id, { mode: message.params.mode });
            send({
              jsonrpc: "2.0",
              method: "ui/notifications/host-context-changed",
              params: { displayMode: message.params.mode },
            });
            return;
          default:
            replyError(message.id, -32601, "Unsupported host method: " + message.method);
        }
      }

      window.addEventListener("message", event => {
        if (!frame || event.source !== frame.contentWindow) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (monitorPostAckMessages) state.postAckMessages++;

        if ("method" in message && "id" in message) {
          void handleRequest(message);
          return;
        }
        if ("method" in message) {
          if (message.method === "ui/notifications/initialized") {
            state.initializedCount++;
            void sendInitialToolResult();
          } else if (message.method === "ui/notifications/size-changed") {
            state.sizeChanges.push(message.params);
          }
          return;
        }

        const pending = pendingHostRequests.get(message.id);
        if (!pending) return;
        pendingHostRequests.delete(message.id);
        if ("error" in message) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      });

      function createFrame() {
        frame = document.createElement("iframe");
        frame.id = "viewer-frame";
        frame.src = "/viewer";
        document.getElementById("frame-root").replaceChildren(frame);
      }

      function request(method, params = {}) {
        const id = nextHostRequestId++;
        return new Promise((resolve, reject) => {
          pendingHostRequests.set(id, { resolve, reject });
          send({ jsonrpc: "2.0", id, method, params });
        });
      }

      async function teardown() {
        state.teardownRequests++;
        const result = await request("ui/resource-teardown");
        state.teardownAcks++;
        return result;
      }

      async function reopen() {
        await teardown();
        frame.remove();
        frame = null;
        await new Promise(resolve => setTimeout(resolve, 50));
        createFrame();
      }

      async function openDelayedLoad() {
        await teardown();
        frame.remove();
        frame = null;
        holdReads = true;
        monitorPostAckMessages = false;
        await new Promise(resolve => setTimeout(resolve, 50));
        createFrame();
      }

      async function teardownTwice() {
        state.teardownRequests += 2;
        await Promise.all([
          request("ui/resource-teardown"),
          request("ui/resource-teardown"),
        ]);
        state.teardownAcks += 2;
        monitorPostAckMessages = true;
      }

      function startConcurrentTeardown() {
        void teardownTwice().catch(error => {
          state.teardownError = error?.message || String(error);
        });
        return true;
      }

      function releaseHeldReads() {
        holdReads = false;
        const requests = heldReadRequests.splice(0);
        state.releasedReadRequests += requests.length;
        for (const message of requests) void replyToReadRequest(message);
        return requests.length;
      }

      function replaceTornDownFrame(zoneType) {
        frame?.remove();
        frame = null;
        holdReads = false;
        holdApplyText = zoneType === "date";
        holdCreateSignature = zoneType === "signature";
        detectedZoneType = zoneType;
        monitorPostAckMessages = false;
        createFrame();
      }

      function enterSignMode() {
        frame.contentDocument.getElementById("mode-sign-btn").click();
      }

      function openFirstSignZone() {
        frame.contentDocument.querySelector(".sign-panel-item")?.click();
      }

      function confirmDateStamp() {
        frame.contentDocument.getElementById("sign-modal-confirm").click();
      }

      function confirmQuickSignature() {
        const doc = frame.contentDocument;
        const nameInput = doc.getElementById("sign-modal-name");
        nameInput.value = "Lifecycle Tester";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        doc.getElementById("sign-modal-confirm").click();
      }

      function releaseHeldApplyText() {
        holdApplyText = false;
        const requests = heldApplyTextRequests.splice(0);
        state.releasedApplyTextRequests += requests.length;
        for (const message of requests) {
          reply(message.id, {
            content: [{ type: "text", text: "Applied delayed date text." }],
            structuredContent: {
              pdf_path: "/fixtures/lifecycle.pdf",
              backup_path: "/fixtures/lifecycle.backup.pdf",
            },
          });
        }
        return requests.length;
      }

      function releaseHeldCreateSignature() {
        holdCreateSignature = false;
        const requests = heldCreateSignatureRequests.splice(0);
        state.releasedCreateSignatureRequests += requests.length;
        for (const message of requests) {
          reply(message.id, {
            content: [{ type: "text", text: "Created delayed lifecycle signature." }],
            structuredContent: { name: "__pdf-tools-quick-typed__" },
          });
        }
        return requests.length;
      }

      function changeTheme(theme) {
        send({
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: {
            theme,
            styles: {
              variables: {
                "--color-background-primary": theme === "dark"
                  ? "rgb(17, 17, 17)"
                  : "rgb(250, 250, 250)",
              },
            },
          },
        });
      }

      function sendProtocolError() {
        state.protocolErrorsSent++;
        send({ jsonrpc: "2.0", method: 42, params: {} });
      }

      function setInitialDeliveryMode(mode) {
        if (![
          "full",
          "full-duplicate",
          "content-only",
          "content-only-no-input",
          "content-only-duplicate",
          "stale-input-mismatch",
          "interleaved-input-result",
          "error",
          "unrecognized",
          "conflict",
          "partial-mismatch",
        ].includes(mode)) {
          throw new Error("Unsupported initial delivery mode: " + mode);
        }
        initialDeliveryMode = mode;
        return mode;
      }

      async function openDeliveryMode(mode) {
        monitorPostAckMessages = false;
        await teardown();
        frame?.remove();
        frame = null;
        setInitialDeliveryMode(mode);
        holdReads = false;
        holdApplyText = false;
        holdCreateSignature = false;
        await new Promise(resolve => setTimeout(resolve, 50));
        createFrame();
        return mode;
      }

      function viewerSnapshot() {
        const doc = frame?.contentDocument;
        const canvas = doc?.getElementById("pdf-canvas");
        const error = doc?.getElementById("error");
        let paintedSampleCount = 0;
        if (canvas?.width > 0 && canvas?.height > 0) {
          const context = canvas.getContext("2d");
          const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
          if (pixels) {
            for (let offset = 0; offset < pixels.length; offset += 400) {
              const alpha = pixels[offset + 3];
              const rgbTotal = pixels[offset] + pixels[offset + 1] + pixels[offset + 2];
              if (alpha > 0 && rgbTotal < 735) paintedSampleCount++;
            }
          }
        }
        return {
          readyState: doc?.readyState || null,
          theme: doc?.documentElement.getAttribute("data-theme") || null,
          background: doc?.documentElement.style.getPropertyValue("--color-background-primary") || null,
          title: doc?.getElementById("pdf-title")?.textContent || null,
          canvasWidth: canvas?.width || 0,
          canvasHeight: canvas?.height || 0,
          paintedSampleCount,
          viewerVisible: doc?.getElementById("viewer")?.style.display === "flex",
          totalPagesText: doc?.getElementById("total-pages")?.textContent || "",
          textLayerText: doc?.getElementById("text-layer")?.textContent || "",
          errorVisible: error?.style.display === "block",
          errorText: doc?.getElementById("error-message")?.textContent || "",
          signItemCount: doc?.querySelectorAll(".sign-panel-item").length || 0,
          signModalDisplay: doc?.getElementById("sign-modal")?.style.display || "",
          signConfirmDisabled: doc?.getElementById("sign-modal-confirm")?.disabled ?? null,
          signConfirmText: doc?.getElementById("sign-modal-confirm")?.textContent || "",
          appliedZoneCount: doc?.querySelectorAll('.sig-zone[data-applied="true"]').length || 0,
          signToastCount: doc?.querySelectorAll(".sign-toast").length || 0,
        };
      }

      window.__hostApi = {
        snapshot: () => JSON.parse(JSON.stringify(state)),
        viewerSnapshot,
        clickFullscreen: () => frame.contentDocument.getElementById("fullscreen-btn").click(),
        changeTheme,
        teardown,
        reopen,
        openDelayedLoad,
        startConcurrentTeardown,
        releaseHeldReads,
        replaceTornDownFrame,
        enterSignMode,
        openFirstSignZone,
        confirmDateStamp,
        confirmQuickSignature,
        releaseHeldApplyText,
        releaseHeldCreateSignature,
        sendProtocolError,
        setInitialDeliveryMode,
        openDeliveryMode,
      };
      createFrame();
    })();
  </script>
</body>
</html>`;
}

const server = http.createServer((request, response) => {
  if (request.url === "/" || request.url === "/index.html") {
    const body = Buffer.from(hostHtml());
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }
  if (request.url === "/viewer") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": viewerHtml.length,
      "cache-control": "no-store",
      // Serve the component under the policy a real sandboxed MCP Apps host
      // applies. Until 2026-08-10 this harness sent no policy at all, so it
      // permitted exactly what a real sandbox refuses: the viewer shipped a
      // ~2.7 MB `data:` worker module, rendered blank in ChatGPT desktop, and
      // every gate here stayed green. A permissive harness cannot detect a
      // permission failure.
      //
      // Transcribed from the ChatGPT Mac desktop app, version 26.803.41515
      // build 6321, observed 2026-08-10 for a component declaring no
      // `_meta.ui.csp`. It is observed implementation, not a published
      // contract, so re-check it before relying on the exact directives.
      //
      // The load-bearing directive is `worker-src`, which that host constructs
      // as `'self' blob:` and never widens with resourceDomains. A `data:`
      // worker is therefore refused twice: once by `worker-src` when pdf.js
      // calls `new Worker()`, and again by `script-src`, which omits `data:`,
      // when its fake-worker fallback dynamically imports the same URL. That
      // is exactly the failure this smoke now reproduces.
      //
      // `D`, the host's built-in resource allowlist (jsdelivr, unpkg, esm.sh
      // and similar), is deliberately omitted: the viewer must not depend on
      // any external origin, so leaving it out keeps this honest.
      "content-security-policy": [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval' blob:",
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "style-src-elem 'self' 'unsafe-inline'",
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "media-src 'self'",
        "object-src 'none'",
        "frame-src 'none'",
        "base-uri 'self'",
      ].join("; "),
    });
    response.end(viewerHtml);
    return;
  }
  if (request.url === "/fixture.pdf") {
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": fixtureBytes.length,
      "cache-control": "no-store",
    });
    response.end(fixtureBytes);
    return;
  }
  response.writeHead(404);
  response.end();
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let value;
  while (Date.now() - startedAt < timeoutMs) {
    value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${message}. Last value: ${JSON.stringify(value)}`);
}

async function closeBrowserSession() {
  try {
    await runAgentBrowser(["close"]);
  } catch {
    // Best-effort cleanup.
  }
}

async function main() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve the lifecycle host's bound port.");
  }
  origin = `http://127.0.0.1:${address.port}`;

  try {
    await runAgentBrowser(["open", origin]);

    const firstState = await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.initializeCount === 1 &&
        state.initializedCount === 1 &&
        state.initialToolInputs === 1 &&
        state.initialToolResults === 1 &&
        state.readBytesCalls > 0 &&
        state.setActiveDocumentCalls > 0 &&
        state.modelContextCalls > 0 &&
        state.sizeChanges.length > 0
        ? state
        : null;
    }, "The first built-viewer lifecycle did not become ready");

    const firstViewer = await evalJson(
      runAgentBrowser,
      "JSON.stringify(window.__hostApi.viewerSnapshot())",
    );
    assert(firstState.resourceLoads === 1, "The host did not fetch the PDF resource exactly once.");
    assert(
      firstState.initializeContractErrors.length === 0,
      `The app sent an unexpected initialize contract: ${firstState.initializeContractErrors.join(", ")}`,
    );
    assert(firstViewer.readyState === "complete", "The built viewer iframe did not finish loading.");
    assert(firstViewer.theme === "light", "The initial host theme was not applied.");
    assert(
      firstViewer.background === "rgb(250, 250, 250)",
      "The initial host style variables were not applied.",
    );
    assert(firstViewer.title === "lifecycle.pdf", "The initial tool result did not load the target PDF.");
    assert(
      firstViewer.canvasWidth > 0 && firstViewer.canvasHeight > 0,
      "The built viewer did not produce a nonzero PDF canvas.",
    );
    assert(firstViewer.viewerVisible, "The built viewer did not enter its loaded state.");
    assert(
      firstViewer.totalPagesText === "of 2",
      `The built viewer reported the wrong page count: ${firstViewer.totalPagesText}`,
    );
    assert(
      firstViewer.textLayerText.includes("BLUEHARBOR-TEXT-20260721"),
      "The built viewer did not render the synthetic text marker.",
    );
    assert(
      firstViewer.paintedSampleCount > 0,
      "The built viewer produced a sized but materially unpainted canvas.",
    );
    assert(
      firstState.invalidReadBytesCalls === 0 &&
        firstState.maxReadByteCount <= 524288 &&
        firstState.readBytesCalls <= 20,
      `The viewer made invalid or unbounded byte reads: ${JSON.stringify({
        calls: firstState.readBytesCalls,
        invalid: firstState.invalidReadBytesCalls,
        max: firstState.maxReadByteCount,
      })}`,
    );
    assert(!firstViewer.errorVisible, `The built viewer showed an error: ${firstViewer.errorText}`);

    await runAgentBrowser(["eval", "window.__hostApi.clickFullscreen()"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.displayModeRequests.includes("fullscreen") ? state : null;
    }, "The fullscreen request did not reach the host");

    await runAgentBrowser(["eval", "window.__hostApi.changeTheme('dark')"]);
    const darkViewer = await waitFor(async () => {
      const snapshot = await evalJson(
        runAgentBrowser,
        "JSON.stringify(window.__hostApi.viewerSnapshot())",
      );
      return snapshot.theme === "dark" ? snapshot : null;
    }, "The changed host theme did not reach the viewer");
    assert(
      darkViewer.background === "rgb(17, 17, 17)",
      "Changed host style variables were not applied.",
    );

    await runAgentBrowser(["eval", "window.__hostApi.setInitialDeliveryMode('full')"]);
    await runAgentBrowser(["eval", "window.__hostApi.reopen()"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.teardownAcks === 1 &&
        state.initializeCount === 2 &&
        state.initializedCount === 2 &&
        state.initialToolResults === 2
        ? state
        : null;
    }, "The built viewer did not acknowledge teardown and reconnect after reopen");

    await runAgentBrowser(["eval", "window.__hostApi.sendProtocolError()"]);
    const errorViewer = await waitFor(async () => {
      const snapshot = await evalJson(
        runAgentBrowser,
        "JSON.stringify(window.__hostApi.viewerSnapshot())",
      );
      return snapshot.errorVisible ? snapshot : null;
    }, "A transport parse error did not propagate to the viewer");
    assert(
      errorViewer.errorText.includes("Invalid JSON-RPC message"),
      `Unexpected viewer transport error: ${errorViewer.errorText}`,
    );

    await runAgentBrowser(["eval", "window.__hostApi.openDelayedLoad()"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.initializeCount === 3 && state.heldReadRequests > 0 ? state : null;
    }, "The delayed-read lifecycle did not reach an in-flight PDF byte request");

    await runAgentBrowser(["eval", "window.__hostApi.startConcurrentTeardown()"]);
    const teardownState = await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      if (state.teardownError) throw new Error(state.teardownError);
      return state.teardownAcks === 4 ? state : null;
    }, "Concurrent teardown requests did not await and acknowledge shared cleanup");
    assert(
      teardownState.releasedReadRequests === 0,
      "Teardown required the delayed byte response instead of cancelling the loading task.",
    );

    await runAgentBrowser(["eval", "window.__hostApi.releaseHeldReads()"]);
    await runAgentBrowser(["wait", "750"]);
    const finalState = await evalJson(
      runAgentBrowser,
      "JSON.stringify(window.__hostApi.snapshot())",
    );
    assert(finalState.releasedReadRequests > 0, "The delayed byte response was not released.");
    assert(
      finalState.postAckMessages === 0,
      `The viewer emitted ${finalState.postAckMessages} host message(s) after teardown acknowledgment.`,
    );

    await runAgentBrowser(["eval", "window.__hostApi.replaceTornDownFrame('date')"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.initializeCount === 4 && state.initializedCount === 4 && state.initialToolResults === 4
        ? state
        : null;
    }, "The delayed date-stamp lifecycle did not initialize");
    await runAgentBrowser(["eval", "window.__hostApi.enterSignMode()"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      const viewer = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.viewerSnapshot())");
      return state.detectZoneCalls >= 1 && viewer.signItemCount === 1 ? { state, viewer } : null;
    }, "The synthetic date zone did not render");
    await runAgentBrowser(["eval", "window.__hostApi.openFirstSignZone()"]);
    await waitFor(async () => {
      const viewer = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.viewerSnapshot())");
      return viewer.signModalDisplay === "flex" && viewer.signConfirmDisabled === false ? viewer : null;
    }, "The synthetic date confirmation did not open");
    await runAgentBrowser(["eval", "window.__hostApi.confirmDateStamp()"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.heldApplyTextRequests === 1 ? state : null;
    }, "The date stamp did not reach a held apply_text request");

    await runAgentBrowser(["eval", "window.__hostApi.startConcurrentTeardown()"]);
    const dateAckState = await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      if (state.teardownError) throw new Error(state.teardownError);
      return state.teardownAcks === 6 ? state : null;
    }, "The date-stamp teardown requests were not acknowledged");
    assert(
      dateAckState.releasedApplyTextRequests === 0,
      "Date-stamp teardown waited for the delayed apply_text result.",
    );
    const dateViewerAfterAck = await evalJson(
      runAgentBrowser,
      "JSON.stringify(window.__hostApi.viewerSnapshot())",
    );
    await runAgentBrowser(["eval", "window.__hostApi.releaseHeldApplyText()"]);
    await runAgentBrowser(["wait", "750"]);
    const dateFinalState = await evalJson(
      runAgentBrowser,
      "JSON.stringify(window.__hostApi.snapshot())",
    );
    const dateViewerAfterRelease = await evalJson(
      runAgentBrowser,
      "JSON.stringify(window.__hostApi.viewerSnapshot())",
    );
    assert(dateFinalState.releasedApplyTextRequests === 1, "The delayed apply_text result was not released.");
    assert(
      dateFinalState.postAckMessages === 0,
      `The delayed apply_text continuation emitted ${dateFinalState.postAckMessages} post-ack message(s).`,
    );
    assert(
      JSON.stringify(dateViewerAfterRelease) === JSON.stringify(dateViewerAfterAck),
      "The delayed apply_text continuation mutated viewer state after teardown acknowledgment.",
    );

    await runAgentBrowser(["eval", "window.__hostApi.replaceTornDownFrame('signature')"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.initializeCount === 5 && state.initializedCount === 5 && state.initialToolResults === 5
        ? state
        : null;
    }, "The delayed quick-sign lifecycle did not initialize");
    await runAgentBrowser(["eval", "window.__hostApi.enterSignMode()"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      const viewer = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.viewerSnapshot())");
      return state.detectZoneCalls >= 2 && viewer.signItemCount === 1 ? { state, viewer } : null;
    }, "The synthetic signature zone did not render");
    await runAgentBrowser(["eval", "window.__hostApi.openFirstSignZone()"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      const viewer = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.viewerSnapshot())");
      return state.listSignatureCalls >= 1 && viewer.signModalDisplay === "flex" ? { state, viewer } : null;
    }, "The synthetic quick-sign confirmation did not open");
    await runAgentBrowser(["eval", "window.__hostApi.confirmQuickSignature()"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.heldCreateSignatureRequests === 1 ? state : null;
    }, "Quick signing did not reach a held create_signature request");

    await runAgentBrowser(["eval", "window.__hostApi.startConcurrentTeardown()"]);
    const createAckState = await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      if (state.teardownError) throw new Error(state.teardownError);
      return state.teardownAcks === 8 ? state : null;
    }, "The quick-sign teardown requests were not acknowledged");
    assert(
      createAckState.releasedCreateSignatureRequests === 0,
      "Quick-sign teardown waited for the delayed create_signature result.",
    );
    const quickViewerAfterAck = await evalJson(
      runAgentBrowser,
      "JSON.stringify(window.__hostApi.viewerSnapshot())",
    );
    const applySignatureCountBeforeRelease = createAckState.applySignatureCalls;
    await runAgentBrowser(["eval", "window.__hostApi.releaseHeldCreateSignature()"]);
    await runAgentBrowser(["wait", "750"]);
    const quickFinalState = await evalJson(
      runAgentBrowser,
      "JSON.stringify(window.__hostApi.snapshot())",
    );
    const quickViewerAfterRelease = await evalJson(
      runAgentBrowser,
      "JSON.stringify(window.__hostApi.viewerSnapshot())",
    );
    assert(
      quickFinalState.releasedCreateSignatureRequests === 1,
      "The delayed create_signature result was not released.",
    );
    assert(
      quickFinalState.applySignatureCalls === applySignatureCountBeforeRelease,
      "The delayed create_signature continuation chained into apply_signature after teardown.",
    );
    assert(
      quickFinalState.postAckMessages === 0,
      `The delayed create_signature continuation emitted ${quickFinalState.postAckMessages} post-ack message(s).`,
    );
    assert(
      JSON.stringify(quickViewerAfterRelease) === JSON.stringify(quickViewerAfterAck),
      "The delayed create_signature continuation mutated viewer state after teardown acknowledgment.",
    );

    const adversarialFailures = {};
    for (const [mode, expectedText] of [
      ["content-only-no-input", "complete load metadata"],
      ["error", "could not open"],
      ["unrecognized", "complete load metadata"],
      ["conflict", "conflicting PDF viewer metadata"],
      ["partial-mismatch", "complete load metadata"],
      ["stale-input-mismatch", "complete load metadata"],
      ["interleaved-input-result", "complete load metadata"],
    ]) {
      const before = await evalJson(
        runAgentBrowser,
        "JSON.stringify(window.__hostApi.snapshot())",
      );
      await runAgentBrowser(["eval", `window.__hostApi.openDeliveryMode(${JSON.stringify(mode)})`]);
      const viewer = await waitFor(async () => {
        const snapshot = await evalJson(
          runAgentBrowser,
          "JSON.stringify(window.__hostApi.viewerSnapshot())",
        );
        return snapshot.errorVisible ? snapshot : null;
      }, `The ${mode} bridge case did not fail visibly`);
      const after = await evalJson(
        runAgentBrowser,
        "JSON.stringify(window.__hostApi.snapshot())",
      );
      assert(
        viewer.errorText.includes(expectedText),
        `The ${mode} bridge case showed an unexpected error: ${viewer.errorText}`,
      );
      assert(!viewer.viewerVisible, `The ${mode} bridge case exposed the viewer shell.`);
      assert(
        after.readBytesCalls === before.readBytesCalls,
        `The ${mode} bridge case made ${after.readBytesCalls - before.readBytesCalls} byte call(s).`,
      );
      adversarialFailures[mode] = viewer;
    }

    const duplicateReceipts = {};
    for (const [mode, maximumReadDelta] of [
      ["content-only-duplicate", 2],
      ["full-duplicate", 1],
    ]) {
      const before = await evalJson(
        runAgentBrowser,
        "JSON.stringify(window.__hostApi.snapshot())",
      );
      await runAgentBrowser(["eval", `window.__hostApi.openDeliveryMode(${JSON.stringify(mode)})`]);
      const viewer = await waitFor(async () => {
        const snapshot = await evalJson(
          runAgentBrowser,
          "JSON.stringify(window.__hostApi.viewerSnapshot())",
        );
        return snapshot.viewerVisible &&
          snapshot.totalPagesText === "of 2" &&
          snapshot.textLayerText.includes("BLUEHARBOR-TEXT-20260721")
          ? snapshot
          : null;
      }, `The ${mode} bridge case did not render exactly once`);
      const after = await evalJson(
        runAgentBrowser,
        "JSON.stringify(window.__hostApi.snapshot())",
      );
      const readDelta = after.readBytesCalls - before.readBytesCalls;
      assert(
        readDelta > 0 && readDelta <= maximumReadDelta,
        `The ${mode} bridge case made an unexpected ${readDelta} byte call(s).`,
      );
      assert(!viewer.errorVisible, `The ${mode} bridge case showed an error: ${viewer.errorText}`);
      duplicateReceipts[mode] = { readDelta, viewer };
    }

    console.log(JSON.stringify({
      status: "pass",
      host: process.platform,
      lifecycle: await evalJson(
        runAgentBrowser,
        "JSON.stringify(window.__hostApi.snapshot())",
      ),
      firstViewer,
      darkViewer,
      errorViewer,
      dateViewerAfterAck,
      quickViewerAfterAck,
      adversarialFailures,
      duplicateReceipts,
    }, null, 2));
  } finally {
    await closeBrowserSession();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(`\n[ui-app-lifecycle-smoke] FAILED: ${error.message}`);
  process.exitCode = 1;
});
