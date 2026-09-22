/**
 * Web-standard entry point for the remote stateless profile.
 *
 * `createMcpHandler` gives back a `fetch(Request) => Response` handler and
 * builds a fresh server per request, so nothing accumulates between calls and
 * a serverless deployment behaves exactly like the local listener below.
 *
 * Run locally:  node remote/http.mjs        (defaults to port 8787)
 */

import { createServer } from "node:http";
import { Readable } from "node:stream";

import { createMcpHandler } from "@modelcontextprotocol/server";

import { createRemoteServer } from "./server.mjs";

export const MAX_REQUEST_BYTES = 34 * 1024 * 1024; // base64 inflates by about a third

/** Errors are reported without request content, per property P4 of the profile. */
const handler = createMcpHandler(() => createRemoteServer(), {
  onerror: (error) => process.stderr.write(`mcp error: ${error?.name ?? "Error"}\n`),
});

export async function handleMcpFetch(request) {
  return handler.fetch(request);
}

/** Node http request to a Web Request, with the body capped before it is read. */
async function toWebRequest(nodeRequest) {
  const url = new URL(nodeRequest.url, `http://${nodeRequest.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
    else if (value !== undefined) headers.set(key, value);
  }
  const method = nodeRequest.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of nodeRequest) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      const error = new Error("REQUEST_TOO_LARGE");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

async function writeWebResponse(webResponse, nodeResponse) {
  nodeResponse.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }
  await new Promise((resolve, reject) => {
    Readable.fromWeb(webResponse.body).pipe(nodeResponse).on("finish", resolve).on("error", reject);
  });
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8787);
  createServer(async (nodeRequest, nodeResponse) => {
    try {
      if (new URL(nodeRequest.url, "http://localhost").pathname !== "/mcp") {
        nodeResponse.writeHead(404, { "content-type": "application/json" });
        nodeResponse.end('{"error":"not found"}');
        return;
      }
      const webResponse = await handleMcpFetch(await toWebRequest(nodeRequest));
      await writeWebResponse(webResponse, nodeResponse);
    } catch (error) {
      const status = error?.statusCode ?? 500;
      if (!nodeResponse.headersSent) nodeResponse.writeHead(status, { "content-type": "application/json" });
      nodeResponse.end(status === 413 ? '{"error":"request too large"}' : '{"error":"internal"}');
    }
  }).listen(port, "127.0.0.1", () => {
    process.stderr.write(`remote MCP on http://127.0.0.1:${port}/mcp\n`);
  });
}
