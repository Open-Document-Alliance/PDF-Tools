import http from "node:http";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CREDENTIAL_TTL_MS = 10 * 60_000;
const WINDOW_TTL_MS = 5 * 60_000;
const MAX_DOCUMENTS = 8;
const MAX_ATTEMPTS = 5;
const MAX_BODY_BYTES = 4096;
const MAX_PASSWORD_BYTES = 1024;
const VALIDATION_TIMEOUT_MS = 30_000;

const PAGE_SCRIPT = `
(() => {
  let token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  const message = document.getElementById("message");
  const password = document.getElementById("password");
  const unlock = document.getElementById("unlock");
  let pending = false;
  async function send(endpoint, values = {}) {
    const response = await fetch(endpoint, { method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...values }) });
    return { ok: response.ok, data: await response.json() };
  }
  async function refresh() {
    try {
      const result = await send("/session");
      if (!result.ok) { message.textContent = "This unlock window has expired. Request a new window in PDF Tools."; unlock.disabled = true; password.value = ""; return; }
      document.getElementById("document").textContent = result.data.filename;
      document.getElementById("source").textContent = "Document fingerprint: " + result.data.source_sha256;
      message.textContent = result.data.status === "unlocked"
        ? "Unlocked for this PDF Tools session. Access expires automatically after 10 minutes. You may close this window or lock the document now."
        : "Enter this document's password. It stays in PDF Tools on this computer and is not sent to chat.";
      unlock.disabled = result.data.status === "unlocked";
    } catch { message.textContent = "PDF Tools is no longer available. You can close this window."; unlock.disabled = true; }
  }
  document.getElementById("form").addEventListener("submit", async event => {
    event.preventDefault();
    if (pending || unlock.disabled) return;
    pending = true; unlock.disabled = true;
    let value = password.value; password.value = "";
    try {
      const promise = send("/unlock", { password: value }); value = "";
      const result = await promise;
      message.textContent = result.ok ? "Document unlocked. You can return to PDF Tools."
        : "The document could not be unlocked. Check the password or request a new unlock window in PDF Tools.";
      unlock.disabled = result.ok;
    } catch { message.textContent = "PDF Tools is no longer available. You can close this window."; }
    finally { value = ""; pending = false; }
  });
  for (const action of ["lock", "cancel"]) document.getElementById(action).addEventListener("click", async () => {
    password.value = ""; unlock.disabled = true;
    try {
      const result = await send("/" + action);
      if (result.ok && result.data.status === "locked") {
        token = "";
        message.textContent = "Document locked. You can close this window.";
        return;
      }
    } catch {}
    message.textContent = "Could not confirm the document is locked. Try again, or use Lock PDF in PDF Tools.";
  });
  addEventListener("pagehide", () => { password.value = ""; token = ""; });
  refresh();
})();`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unlock PDF in PDF Tools</title><style>
body{font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;color:#18212f;background:#f8fafc}main{background:white;padding:2rem;border:1px solid #dbe3ed;border-radius:14px}h1{font-size:1.6rem}label{display:block;margin-top:1.4rem}input{box-sizing:border-box;width:100%;font:inherit;padding:.7rem;margin:.5rem 0 1rem;border:1px solid #66758a;border-radius:5px}button{font:inherit;padding:.65rem 1rem;margin:.3rem .3rem .3rem 0;cursor:pointer}#source{overflow-wrap:anywhere;color:#526174;font-size:.8rem}#document{overflow-wrap:anywhere;font-weight:600}#message{line-height:1.5}button:focus-visible,input:focus-visible{outline:3px solid #2463eb;outline-offset:3px}
</style></head><body><main><h1>Unlock your PDF</h1><p id="document">PDF Tools</p><p id="source"></p><p id="message" role="status" aria-live="polite">Opening private password entry...</p><form id="form"><label for="password">PDF password</label><input id="password" type="password" autocomplete="off" maxlength="1024" required><button id="unlock" type="submit">Unlock document</button><button id="lock" type="button">Lock document</button><button id="cancel" type="button">Cancel</button></form><p>Keep this window private. Access is limited to this document and ends when PDF Tools closes.</p></main><script>${PAGE_SCRIPT}</script></body></html>`;
const SCRIPT_SHA = createHash("sha256").update(PAGE_SCRIPT).digest("base64");

function fixedError(code) {
  const error = new Error("Private PDF access is unavailable. Request a new unlock window in PDF Tools.");
  error.code = code;
  return error;
}

function sourceIdentity(source) {
  if (!source || typeof source.canonical_path !== "string" || !path.isAbsolute(source.canonical_path) ||
      !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.size_bytes) || source.size_bytes < 0 ||
      !source.file_identity || !["number", "string", "bigint"].includes(typeof source.file_identity.device) ||
      !["number", "string", "bigint"].includes(typeof source.file_identity.inode)) {
    throw fixedError("PRIVATE_PDF_SOURCE_INVALID");
  }
  return JSON.stringify([source.canonical_path, String(source.file_identity.device),
    String(source.file_identity.inode), source.sha256, source.size_bytes]);
}

function tokenMatches(expected, actual) {
  return typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function exactKeys(value, names) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === names.sort().join(",");
}

// The injected callbacks are local trusted code. The service does not establish
// authenticity against another process running as the same OS user or root.
// Passwords stay in JavaScript memory; GC and OS swap do not guarantee erasure.
export function createPrivatePdfCredentials({ bindSource, validatePassword, openWindow, now = Date.now }) {
  if (![bindSource, validatePassword, openWindow, now].every(value => typeof value === "function")) {
    throw fixedError("PRIVATE_PDF_CONFIGURATION_INVALID");
  }
  const documents = new Map();
  const windows = new Map();
  let server;
  let starting;
  let origin;
  let closed = false;
  let pendingBindings = 0;
  let validating = false;
  let attemptWindowStart = now();
  let globalAttempts = 0;
  let cancelValidation;

  function clearDocument(entry, status = "locked") {
    entry.password = undefined;
    entry.expiresAt = 0;
    entry.status = status;
    entry.generation += 1;
    if (cancelValidation?.entry === entry) cancelValidation.clear();
    for (const [token, session] of windows) if (session.entry === entry) windows.delete(token);
  }

  function prune() {
    const time = now();
    for (const entry of documents.values()) {
      if (entry.password !== undefined && entry.expiresAt <= time) clearDocument(entry, "expired");
    }
    for (const [token, session] of windows) {
      if (session.expiresAt <= time) {
        windows.delete(token);
        if (session.entry.status === "awaiting_password") clearDocument(session.entry, "expired");
      }
    }
  }

  function result(entry) {
    return entry?.password !== undefined
      ? { status: "unlocked", expires_at: new Date(entry.expiresAt).toISOString() }
      : { status: entry?.status ?? "locked" };
  }

  async function bind(pdfPath) {
    if (closed || pendingBindings >= MAX_DOCUMENTS) throw fixedError("PRIVATE_PDF_UNAVAILABLE");
    pendingBindings += 1;
    try {
      const source = await bindSource(pdfPath);
      if (closed) throw fixedError("PRIVATE_PDF_UNAVAILABLE");
      sourceIdentity(source);
      return { ...source, file_identity: { ...source.file_identity } };
    } catch {
      throw fixedError("PRIVATE_PDF_SOURCE_UNAVAILABLE");
    } finally { pendingBindings -= 1; }
  }

  function lookup(source) {
    prune();
    const key = sourceIdentity(source);
    const entry = documents.get(source.canonical_path);
    if (entry && entry.key !== key) {
      clearDocument(entry);
      documents.delete(source.canonical_path);
      return undefined;
    }
    return entry;
  }

  function respond(response, statusCode, value) {
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "Pragma": "no-cache", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin", "Connection": "close",
    });
    response.end(JSON.stringify(value));
  }

  async function readBody(request) {
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const chunks = [];
      let finished = false;
      const fail = () => {
        if (finished) return;
        finished = true;
        chunks.length = 0;
        clearTimeout(timer);
        reject(fixedError("PRIVATE_PDF_REQUEST_INVALID"));
      };
      const timer = setTimeout(fail, 5000);
      const cleanup = () => clearTimeout(timer);
      request.on("data", chunk => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) fail();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        if (finished) return;
        finished = true;
        cleanup();
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(fixedError("PRIVATE_PDF_REQUEST_INVALID")); }
        finally { chunks.length = 0; }
      });
      request.on("error", fail);
      request.on("aborted", fail);
    });
  }

  async function handle(request, response) {
    const denied = (code = 403) => respond(response, code, { error: "Private PDF request rejected." });
    if (closed || request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== new URL(origin).host ||
        request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host").length !== 1) return denied();
    if (request.method === "GET" && request.url === "/") {
      if (request.headers["sec-fetch-dest"] === "iframe") return denied();
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Pragma": "no-cache",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${SCRIPT_SHA}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
      });
      response.end(PAGE);
      return;
    }
    if (request.method !== "POST" || !["/session", "/unlock", "/lock", "/cancel"].includes(request.url) ||
        request.headers.origin !== origin || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") ||
        Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return denied();
    let body;
    try { body = await readBody(request); } catch { return denied(400); }
    prune();
    if (!exactKeys(body, request.url === "/unlock" ? ["token", "password"] : ["token"])) return denied(400);
    const session = [...windows.values()].find(item => tokenMatches(item.token, body.token));
    if (!session || closed) return denied();
    const entry = session.entry;
    if (request.url === "/lock" || request.url === "/cancel") {
      clearDocument(entry);
      return respond(response, 200, { status: "locked" });
    }
    if (request.url === "/session") {
      try {
        if (lookup(await bind(entry.source.canonical_path)) !== entry) return denied();
      } catch { clearDocument(entry); return denied(); }
      return respond(response, 200, { ...result(entry), filename: path.basename(entry.source.canonical_path), source_sha256: entry.source.sha256 });
    }
    if (typeof body.password !== "string" || body.password.length === 0 || Buffer.byteLength(body.password, "utf8") > MAX_PASSWORD_BYTES) return denied(400);
    if (entry.password !== undefined || validating || session.validating || session.attempts >= MAX_ATTEMPTS) return denied(409);
    if (now() - attemptWindowStart >= 60_000) { attemptWindowStart = now(); globalAttempts = 0; }
    if (globalAttempts >= 20) return denied(429);
    session.attempts += 1;
    globalAttempts += 1;
    validating = true;
    session.validating = true;
    const generation = entry.generation;
    let password = body.password;
    body.password = undefined;
    const cancellation = { entry, clear: () => { password = undefined; } };
    cancelValidation = cancellation;
    let timer;
    let timedOut = false;
    // Retain the global validation lock until the actual callback ends, even if
    // its HTTP timeout wins. A hung callback cannot create unbounded workers.
    const work = (async () => {
      const before = await bind(entry.source.canonical_path);
      if (sourceIdentity(before) !== entry.key) { clearDocument(entry); return false; }
      if (closed || generation !== entry.generation || windows.get(session.token) !== session || password === undefined) return false;
      const valid = await validatePassword(before, password);
      const after = await bind(entry.source.canonical_path);
      if (sourceIdentity(after) !== entry.key) { clearDocument(entry); return false; }
      return valid === true;
    })();
    work.catch(() => {}).finally(() => { validating = false; session.validating = false; });
    try {
      const valid = await Promise.race([work, new Promise(resolve => {
        timer = setTimeout(() => { timedOut = true; resolve(false); }, VALIDATION_TIMEOUT_MS);
      })]);
      prune();
      if (!valid || timedOut || closed || generation !== entry.generation || windows.get(session.token) !== session ||
          documents.get(entry.source.canonical_path) !== entry || session.expiresAt <= now()) return denied();
      entry.password = password;
      entry.expiresAt = now() + CREDENTIAL_TTL_MS;
      entry.status = "unlocked";
      // After entry, this capability also owns the visible Lock/Cancel action.
      // Keep that action valid for the complete credential lifetime.
      session.expiresAt = entry.expiresAt;
      return respond(response, 200, result(entry));
    } catch { return denied(); }
    finally {
      clearTimeout(timer);
      password = undefined;
      if (cancelValidation === cancellation) cancelValidation = undefined;
    }
  }

  async function ensureServer() {
    if (closed) throw fixedError("PRIVATE_PDF_UNAVAILABLE");
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      server = http.createServer((request, response) => {
        handle(request, response).catch(() => {
          if (!response.headersSent) respond(response, 500, { error: "Private PDF request rejected." });
          else response.destroy();
        });
      });
      server.maxConnections = 16;
      server.requestTimeout = 10_000;
      server.headersTimeout = 5000;
      server.keepAliveTimeout = 1000;
      server.on("clientError", (_error, socket) => socket.destroy());
      server.once("error", () => reject(fixedError("PRIVATE_PDF_UNAVAILABLE")));
      server.listen(0, "127.0.0.1", () => {
        if (closed) { server.close(); reject(fixedError("PRIVATE_PDF_UNAVAILABLE")); return; }
        origin = `http://127.0.0.1:${server.address().port}`;
        server.unref();
        resolve();
      });
    });
    try { await starting; } catch { starting = undefined; throw fixedError("PRIVATE_PDF_UNAVAILABLE"); }
  }

  const expiryTimer = setInterval(prune, 1000);
  expiryTimer.unref();

  function passwordForSource(source) {
    if (closed) return undefined;
    return lookup(source)?.password;
  }

  return {
    async requestUnlock(pdfPath) {
      const source = await bind(pdfPath);
      let entry = lookup(source);
      if (entry?.password !== undefined) return result(entry);
      if (!entry) {
        // Locked/expired records carry no secret and can be evicted to admit a
        // new document. Active credentials and windows count against the cap.
        for (const [name, item] of documents) {
          if (documents.size < MAX_DOCUMENTS) break;
          if (!item.password && item.status !== "awaiting_password") documents.delete(name);
        }
        if (documents.size >= MAX_DOCUMENTS) throw fixedError("PRIVATE_PDF_CAPACITY_REACHED");
        entry = { source, key: sourceIdentity(source), password: undefined, expiresAt: 0, generation: 0, status: "locked" };
        documents.set(source.canonical_path, entry);
      }
      clearDocument(entry);
      const generation = entry.generation;
      await ensureServer();
      if (closed || entry.generation !== generation || documents.get(source.canonical_path) !== entry) throw fixedError("PRIVATE_PDF_UNAVAILABLE");
      const token = randomBytes(32).toString("hex");
      const session = { token, entry, expiresAt: now() + WINDOW_TTL_MS, attempts: 0, validating: false };
      windows.set(token, session);
      entry.status = "awaiting_password";
      try { await openWindow(`${origin}/#${token}`); }
      catch {
        if (windows.get(token) === session) clearDocument(entry);
        throw fixedError("PRIVATE_PDF_WINDOW_UNAVAILABLE");
      }
      if (closed || windows.get(token) !== session) throw fixedError("PRIVATE_PDF_UNAVAILABLE");
      return result(entry);
    },
    async status(pdfPath) {
      const source = await bind(pdfPath);
      return result(lookup(source));
    },
    async lock(pdfPath) {
      // Invalidate before any asynchronous source operation. A concurrent
      // validation cannot restore a credential after the lock starts.
      const direct = documents.get(pdfPath);
      if (direct) clearDocument(direct);
      const source = await bind(pdfPath);
      const entry = documents.get(source.canonical_path);
      if (entry) clearDocument(entry);
      return { status: "locked" };
    },
    passwordForSource,
    passwordForSources(sources) {
      if (!Array.isArray(sources) || sources.length === 0) return undefined;
      const passwords = sources.map(source => passwordForSource(source));
      if (passwords.every(value => value === undefined)) return undefined;
      if (passwords.some(value => value === undefined || value !== passwords[0])) throw fixedError("PRIVATE_PDF_MULTIPLE_DOCUMENTS_LOCKED");
      return passwords[0];
    },
    async close() {
      closed = true;
      clearInterval(expiryTimer);
      for (const entry of documents.values()) clearDocument(entry);
      documents.clear(); windows.clear();
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
