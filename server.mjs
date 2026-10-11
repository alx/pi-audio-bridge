// pi-audio-bridge server: serves the app and proxies /v1/* + /health to
// audio.cpp:8090 and /bridge/* to bridge.mjs:8092.
// Same-origin is required because Chrome forbids streaming (ReadableStream) request
// bodies on cross-origin/CORS-preflighted requests — which is exactly what the
// /live endpoints need.
//
// Two transport modes share one routing/proxy core:
//   node server.mjs [ui]       plain HTTP/1.1 loopback (:8091), serve web/<ui>
//   node server.mjs --tls      HTTPS + HTTP/2, ALPN h2 only (:8443)
//   node server.mjs --ui talk  pick an experiment (or: ./start.sh talk)
// UI defaults to "main"; each experiment lives in web/<ui>/ (see start.sh).
// Chrome requires HTTP/2 (ALPN "h2") to accept streaming request bodies, so remote
// access goes through --tls. Any publicly trusted cert works; to provision one on
// your own infra without running a CA: enable HTTPS certs on your tailnet
// (`tailscale cert` support requires a tailnet with Let's Encrypt enabled), then
// `tailscale cert <tsnet>.<tailnet>.ts.net` writes the LE-issued cert+key. Point
// TLS_CERT/TLS_KEY env vars at them (or drop them in ./certs with the default names).
import http2 from "node:http2";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// UI experiment to serve: --ui <name>, --ui=<name>, or a positional arg.
// Each experiment is a folder of static files under web/; "/" maps to its index.html.
let UI = "main";
{
  const argv = process.argv.slice(2);
  const taken = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ui") { UI = argv[++i]; taken.add(i - 1); taken.add(i); }
    else if (a.startsWith("--ui=")) UI = a.slice(5);
    else if (!a.startsWith("--") && !taken.has(i) && !/^\d+$/.test(a)) UI = a;
  }
}
if (!/^[-a-z0-9][-a-z0-9._]*$/.test(UI))
  throw new Error(`bad --ui name: ${UI} (want web/<name> folder, e.g. main|chat|talk)`);
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const WEB = path.join(ROOT, "web", UI);
if (!fs.existsSync(path.join(WEB, "index.html")))
  throw new Error(`no web/${UI}/index.html — available: ${fs.readdirSync(path.join(ROOT, "web")).join(", ")}`);
const TLS = process.argv.includes("--tls") || process.env.TLS === "1";
const PORT = Number(process.env.PORT || (TLS ? 8443 : 8091));
const HOST = process.env.HOST || (TLS ? "0.0.0.0" : "127.0.0.1");   // TLS is reachable via the tailnet IP
// env-overridable so tests can point at stub upstreams
const API_HOST = process.env.API_HOST || "127.0.0.1";
const API_PORT = Number(process.env.API_PORT || 8090);
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8092);
const CERT_DIR = path.join(WEB, "certs");
// Auto-discover the cert: first *.crt (or *.pem) in ./certs, key = same basename.
// Override with TLS_CERT/TLS_KEY. E.g. tailscale: `sudo tailscale cert <node>.<tailnet>.ts.net
// --cert-file ./certs/server.crt --key-file ./certs/server.key` (needs tailnet HTTPS certs on).
const certName = fs.existsSync(CERT_DIR) && fs.readdirSync(CERT_DIR).find(f => /\.(crt|pem)$/.test(f));
const CERT = process.env.TLS_CERT || (certName ? path.join(CERT_DIR, certName) : null);
const KEY  = process.env.TLS_KEY  || (CERT ? CERT.replace(/\.(crt|pem)$/, ".key") : null);
if (TLS && (!CERT || !KEY || !fs.existsSync(CERT) || !fs.existsSync(KEY)))
  throw new Error(`TLS mode needs a cert pair: set TLS_CERT/TLS_KEY or put <name>.crt + <name>.key in ${CERT_DIR}`);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".wav": "audio/wav", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon" };
// hop-by-hop headers must not be forwarded in responses (h2 resets the stream on
// Keep-Alive/Connection/etc.; in http/1.1 Node re-frames the body automatically)
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection",
                     "proxy-authenticate", "proxy-authorization", "te", "trailer"]);
const tag = TLS ? "[h2]" : "[srv]";

// a single cancelled/crashed stream must never take the voice server down
process.on("uncaughtException", e => console.error(tag, "uncaught:", e && e.message));
process.on("unhandledRejection", e => console.error(tag, "unhandled:", e && (e.message || e)));

// ---- response adapters ------------------------------------------------------
// http's ServerResponse already has the writeHead/write/end shape; http2's
// Http2Stream needs writeHead -> respond({":status", ...headers}). Everything else
// (write/end/on/once/emit/removeListener/destroy/...) passes straight through, so
// the stream is also pipe-destinable. With this in place the shared core below is
// transport-agnostic.
function adaptHttp2(stream) {
  stream.on("error", e => console.error(tag, "stream error:", e.message));
  let sent = false;
  return new Proxy(stream, {
    get(t, p) {
      if (p === "writeHead") return (code, headers = {}) => { t.respond({ ":status": code, ...headers }); sent = true; };
      if (p === "headersSent") return sent;
      if (p === "destroyed") return t.destroyed || t.closed;
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

// ---- shared request core ----------------------------------------------------
function handle(method, url, headers, req, res) {
  res.on("error", e => console.error(tag, "res error:", e.message));
  const u = new URL(url, "http://localhost");   // u.pathname excludes the query string
  let pathname = u.pathname;
  try { pathname = decodeURIComponent(pathname); } catch {}
  const isBridge = pathname.startsWith("/bridge/");
  if (pathname === "/health" || pathname.startsWith("/v1/") || isBridge)
    return proxy(method, url, headers, req, res, isBridge ? BRIDGE_PORT : API_PORT, isBridge);
  // static; "/" maps to index.html. The ^(\.\.[/\\])+ strip plus normalize keep
  // lookups inside WEB.
  serveFile(pathname === "/" ? path.join(WEB, "index.html")
    : path.join(WEB, path.normalize(pathname).replace(/^(\.\.[/\\])+/, "")), res);
}

function serveFile(p, res) {
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
}

function proxy(method, url, headers, req, res, port, isBridge) {
  // Forward the FULL path+query upstream (live routes need ?model=... etc.).
  // The bridge serves /bridge/* itself — do not strip the prefix.
  const upstreamPath = url;
  const fwd = {};
  for (const [k, v] of Object.entries(headers))
    if (!k.startsWith(":")) fwd[k] = v;   // drop h2 pseudo-headers (:method/:path/:scheme/:authority)
  fwd.host = `${API_HOST}:${port}`;
  // We stream the body ourselves, so we own the framing. Forwarding the client's
  // content-length while re-streaming makes the upstream read a truncated body
  // (the h2 POST to /bridge/reply came through as 400 "missing text"). Declaring
  // chunked on a bodyless GET makes the upstream wait for a body that never
  // arrives, so only declare it when the request can carry one.
  if (method !== "GET" && method !== "HEAD") {
    delete fwd["content-length"];
    fwd["transfer-encoding"] = "chunked";
  } else {
    delete fwd["transfer-encoding"];
    delete fwd["content-length"];
  }

  const alive = () => !res.destroyed;
  let responded = false;
  const safeEnd = (code, msg) => {
    try {
      if (!res.headersSent && alive()) {
        responded = true;
        res.writeHead(code, { "content-type": "text/plain" });
        res.end(msg);
      }
    } catch {}
  };

  if (process.env.H2_DEBUG === "1") console.error(`[h2->] ${method} ${upstreamPath} -> ${API_HOST}:${port} te=${fwd["transfer-encoding"]||"-"} cl=${fwd["content-length"]||"-"}`);
  const preq = http.request({ host: API_HOST, port, method, path: upstreamPath, headers: fwd }, pres => {
    if (process.env.H2_DEBUG === "1") console.error(`[h2<-] status=${pres.statusCode}`);
    // Client may have cancelled (barge-in, tab close, navigate) — then the
    // stream/response is gone; dropping the upstream is correct.
    if (!alive()) { pres.destroy(); return; }
    const out = {};
    for (const [k, v] of Object.entries(pres.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
    try { res.writeHead(pres.statusCode, out); responded = true; } catch (e) { pres.destroy(); return; }
    pres.on("error", () => { try { if (alive()) res.destroy(); } catch {} });
    pres.pipe(res);
  });
  // Node >=24 arms a default 5s idle timer on http.request — far too short for a pi
  // turn that runs tools between TTS chunks. Set the idle budget explicitly.
  preq.setTimeout(Number(process.env.UPSTREAM_TIMEOUT_MS || 300000));
  preq.on("timeout", () => { if (process.env.H2_DEBUG === "1") console.error("[h2] upstream timeout"); preq.destroy(new Error("timeout")); });
  preq.on("error", e => { if (process.env.H2_DEBUG === "1") console.error("[h2] upstream error: " + e.message); safeEnd(502, `${isBridge ? "bridge" : "upstream"} ${API_HOST}:${port} error: ${e.message}`); });
  req.on("error", () => { try { preq.destroy(); } catch {} });
  res.on("close", () => { try { if (!responded && !preq.destroyed) preq.destroy(); } catch {} });
  req.pipe(preq);
}

// ---- transports -------------------------------------------------------------
if (TLS) {
  const server = http2.createSecureServer({
    cert: fs.readFileSync(CERT),
    key: fs.readFileSync(KEY),
    allowHTTP1: false,           // force h2: streaming uploads depend on it
    ALPNProtocols: ["h2"],
  });
  server.on("stream", (stream, headers) => {
    const res = adaptHttp2(stream);
    handle(headers[":method"] || "GET", headers[":path"] || "/", headers, stream, res);
  });
  server.listen(PORT, HOST, () => console.log(`pi-audio-bridge HTTPS/h2 on ${HOST}:${PORT} (cert ${path.basename(CERT)})`));
} else {
  const server = http.createServer((req, res) => handle(req.method, req.url, req.headers, req, res));
  server.listen(PORT, HOST, () => console.log(`pi-audio-bridge (ui: ${UI}) on http://${HOST}:${PORT}  (proxying /v1/* + /health -> ${API_HOST}:${API_PORT})`));
}
