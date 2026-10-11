// pi voice bridge: voice transcript -> persistent pi session -> spoken reply.
//
// Contract (consumed by index.html):
//   POST /bridge/reply  {"text": "..."}
//   -> 200, Content-Type: audio/L16;rate=24000  (raw PCM s16le mono), streamed
//      X-Voice-Summary: the speakable text that was spoken (URL-encoded)
//   -> 409 if a turn is already running   -> 504 on pi timeout   -> 502 on failure
//
// The body is STREAMED: each sentence is spoken as soon as pi produces it, so the user
// hears the first sentence while pi is still working on the rest of the turn.
//
// Design notes:
//  - ONE long-lived `pi --mode rpc` session, so follow-ups ("do that again", "and tests?")
//    keep context. A fresh session per utterance would make the voice loop amnesiac.
//  - The speakable transform is deliberately conservative: when unsure, say less and show
//    more. pi's replies are code-heavy and unlistenable verbatim.
//  - The bridge must never deadlock: pi turns get a hard timeout and the HTTP handler
//    always settles its request.
import { spawn } from "node:child_process";
import http from "node:http";
import { wavToPCM } from "./wav.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 8092);
const HOST = "127.0.0.1";
const AUDIO = process.env.AUDIO_API || "http://127.0.0.1:8090";
const TTS_MODEL = process.env.TTS_MODEL || "kokoro-tts";
const TTS_VOICE = process.env.TTS_VOICE || "af_heart";
const TTS_LANG = process.env.TTS_LANG || "en-us";
const PI_CWD = process.env.VOICE_CWD || process.cwd();
const MODEL = process.env.VOICE_MODEL || "gd/qwen3.8-27b";
const THINKING = process.env.VOICE_THINKING || "off";   // reasoning traces are never spoken
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 180000);
const FIRST_SENTENCE_MS = Number(process.env.FIRST_SENTENCE_MS || 2500);
const MAX_SPOKEN_CHARS = Number(process.env.MAX_SPOKEN_CHARS || 240);   // per clause budget
const MAX_TOTAL_SPOKEN = Number(process.env.MAX_TOTAL_SPOKEN || 600);  // whole-reply budget
const WORKING_CUE = process.env.WORKING_CUE || "Working on it.";

/* ------------------------------------------------------------------ speakable */

// Turn a code-heavy pi reply into something worth hearing.
// Conservative by design: strip what cannot be spoken, keep the first few sentences.
export function speakable(md, maxChars = MAX_SPOKEN_CHARS) {
  if (!md) return "";
  let t = String(md);
  t = t.replace(/```[\s\S]*?```/g, " ");            // fenced code
  t = t.replace(/`([^`]*)`/g, (m, p) => (/[/\\.]|^[a-z_]+\(|\.(js|ts|mjs|py|json|md|sh|html|css)$/i.test(p.trim()) ? " " : p));
  t = t.replace(/^\s{4,}.*$/gm, " ");               // indented code blocks
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");  // links -> label
  t = t.replace(/https?:\/\/\S+/g, " ");            // bare URLs
  t = t.replace(/^\s*\|.*\|\s*$/gm, " ");           // tables
  t = t.replace(/^\s*[-*+]\s+/gm, "");              // bullets
  t = t.replace(/^\s*#{1,6}\s*/gm, "");             // headings
  t = t.replace(/(^|\s)[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1$2"); // emphasis
  t = t.replace(/[`*_#>|]+/g, " ");
  t = t.replace(/\s*—\s*/g, ", ");
  t = t.replace(/\bSee\s+for\s+details?\.?/gi, "");      // URL was stripped from "See <url> for details."
  t = t.replace(/\b(?:in|at)\s+on\s+(line|row)\b/gi, "on $1"); // path stripped from "failing in <path> on line 42"

  // ---- spoken-friendly normalisation (a voice reply is not a document) ----
  t = t.replace(/\s*[\u2192\u21d2]\s*/g, " to ");        // arrows: "mic -> ASR" reads as "mic to ASR"
  t = t.replace(/\s*(?:--|\u2014|\u2013)\s*/g, ", ");
  t = t.replace(/\bhttps?:\/\/[^\s,;)]+/gi, " ");
  t = t.replace(/\breachable at\s+on\b/gi, "reachable on");          // URL removed from "reachable at <url> on"
  t = t.replace(/\bat\s+on\s+(the|your)\b/gi, "on $1");
  // a fragment that begins with a query-string param ("in=fr-FR&out=fr-fr presets ...")
  t = t.replace(/^(?:[a-z_]+=[^\s]*&?)+(?=\s)/i, "the URL parameter ");
  t = t.replace(/\b[\w.-]+\.(?:ts|js|mjs|json|md|py|sh|html|css|gguf|toml|yml)\b/gi, " "); // filenames
  t = t.replace(/\b\d+(?:\.\d+)+\b/g, m => m.replace(/\./g, " point "));  // version numbers
  t = t.replace(/\b(?:e\.g|i\.e|etc)\./gi, m => m.slice(0, -1) + ",");
  t = t.replace(/\bHTTP\/(\d)/gi, "HTTP $1");
  // drop parenthetical asides: they are almost always technical (ports, flags, versions)
  t = t.replace(/\([^()]{0,120}\)/g, " ");
  t = t.replace(/[\u2192\u21d2\u00ab\u00bb]/g, " ");
  t = t.replace(/[\u201c\u201d\u2018\u2019]/g, "");      // smart quotes -> nothing (TTS handles plain)
  t = t.replace(/[?!]{2,}/g, ".");
  t = t.replace(/(?:^|\s)[-\u2022*]\s+/g, " ");
  t = t.replace(/\s+([,.;:!?])/g, "$1");              // no space before punctuation
  t = t.replace(/([,;:])\s*([.!?])/g, "$2");           // ", ." -> "."
  t = t.replace(/\s*:\s*/g, ": ");                    // tidy stray colons
  t = t.replace(/\s+([,.;:!?])\s*$/g, "$1");
  t = t.replace(/\s+/g, " ").trim();                // newlines -> spaces (no pauses on markdown)

  if (!t) return "";
  // Keep whole sentences while they fit. Never chop mid-phrase: a spoken fragment is worse
  // than saying less (the full detail is on screen).
  const parts = (t.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [t]).map(x => x.trim()).filter(Boolean);
  let out = "";
  for (const part of parts) {
    if (out && (out + " " + part).length > maxChars) break;
    out = out ? out + " " + part : part;
    if (out.length >= maxChars) break;
  }
  if (out.length > maxChars) {
    // over budget on the very first sentence: cut at a clause boundary, drop the remainder
    const cut = Math.max(out.lastIndexOf(", ", maxChars), out.lastIndexOf("; ", maxChars), out.lastIndexOf(" ", maxChars));
    out = cut > maxChars * 0.5 ? out.slice(0, cut).replace(/[\s,;]+$/, "") + "." : out.slice(0, maxChars).replace(/\s+\S*$/, "") + ".";
  }
  return out.trim();
}

/* ------------------------------------------------------------------ pi session */

class PiSession {
  constructor() {
    this.proc = null;
    this.buf = "";
    this.seq = 0;
    this.pending = null;       // {resolve, reject, gen}
    this.gen = 0;
    this.busy = false;
    this.verbose = process.env.BRIDGE_DEBUG === "1";
  }
  start() {
    if (this.proc) return;
    const args = ["--mode", "rpc", "--no-session", "--thinking", THINKING];
    if (process.env.VOICE_TOOLS) args.push("-t", process.env.VOICE_TOOLS);
    // Sanitize the environment: if the bridge is launched from inside a pi session (common
    // during development) the parent exports PI_MODEL / PI_PROVIDER / PI_SESSION_FILE, which
    // would silently override the voice model and even resume the parent's session.
    const env = { ...process.env };
    for (const k of ["PI_MODEL", "PI_PROVIDER", "PI_SESSION_FILE", "PI_SESSION_ID", "PI_REASONING_LEVEL", "PI_CODING_AGENT"]) delete env[k];
    if (MODEL.includes("/")) { const i = MODEL.indexOf("/"); args.push("--provider", MODEL.slice(0, i), "--model", MODEL.slice(i + 1)); }
    console.error("[bridge] spawning: pi " + args.join(" ") + "  (cwd " + PI_CWD + ")");
    this.proc = spawn("pi", args, { stdio: ["pipe", "pipe", "pipe"], cwd: PI_CWD, env });
    this.proc.stdout.on("data", d => this._onData(d));
    this.proc.stderr.on("data", d => {
      const s = String(d).trim();
      // extension warnings are noise; real errors matter
      if (!s) return;
      if (/^Warning:/.test(s) && !this.verbose) return;
      console.error("[pi stderr] " + s.slice(0, 400));
    });
    this.proc.on("exit", (code, sig) => {
      console.error(`[pi] exited code=${code} sig=${sig}`);
      this.proc = null;
      if (this.pending) { const p = this.pending; this.pending = null; this.busy = false; p.reject(new Error("pi exited")); }
    });
  }
  _onData(d) {
    this.buf += String(d);
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (this.verbose) console.error("[pi<<]", line.slice(0, 200));
      this._onRecord(m);
    }
  }
  _onRecord(m) {
    const p = this.pending;
    if (!p || p.gen !== this.gen) return;
    switch (m.type) {
      case "message_update": {
        const ev = m.assistantMessageEvent || {};
        if (ev.type === "text_delta") {
          p.sawText = true;
          p.onDelta(ev.delta);
        } else if (ev.type === "thinking_delta" && !p.sawText) {
          // only used as a fallback: many routers expose the real answer as "thinking"
          p.thinking = (p.thinking || "") + (ev.delta || "");
        }
        break;
      }
      case "tool_execution_start":
        p.onTool(m.toolName, m.args);
        p.toolCount = (p.toolCount || 0) + 1;
        break;
      case "agent_end":
        // authoritative fallback: pull the final assistant text out of the run's messages
        if (!p.sawText && Array.isArray(m.messages)) {
          for (const msg of m.messages) {
            if (msg.role !== "assistant") continue;
            if (typeof msg.content === "string") { p.text = msg.content; p.sawText = true; }
            else if (Array.isArray(msg.content)) {
              const t = msg.content.filter(c => c.type === "text").map(c => c.text).join("");
              if (t) { p.text = t; p.sawText = true; }
            }
          }
        }
        break;
      case "agent_settled":
        this._settle("");
        break;
      // NB: do NOT settle on turn_end — a tool-using turn has several, and settling early
      // would truncate the reply. agent_settled is the session-level completion signal.
      case "response":
        if (m.command === "prompt" && !m.success) { this.busy = false; this.pending = null; p.reject(new Error(m.error || "prompt rejected")); }
        // a prompt can report disposition "handled" (e.g. a slash command) => no run will follow
        else if (m.command === "prompt" && m.success && m.data && m.data.disposition === "handled") this._settle("");
        break;
    }
  }
  _settle(err) {
    const p = this.pending; if (!p) return;
    this.pending = null; this.busy = false;
    if (err) return p.reject(new Error(err));
    // text wins; thinking is only used if the model put the answer there
    p.resolve(p.sawText ? (p.text || "") : (p.text || p.thinking || ""));
  }
  // stream a prompt; callbacks fire as the turn progresses; resolves at agent_settled
  run(message, { onDelta, onTool, timeoutMs = TURN_TIMEOUT_MS } = {}) {
    this.start();
    const gen = ++this.gen;
    return new Promise((resolve, reject) => {
      let text = "";
      let timer = setTimeout(() => {
        this.busy = false; this.pending = null; this.gen++;
        reject(new Error("pi turn timed out"));
      }, timeoutMs);
      this.pending = {
        gen, text,
        onDelta: d => { text += d; this.pending && (this.pending.text = text); onDelta && onDelta(d); },
        onTool: (n, a) => onTool && onTool(n, a),
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      };
      this.busy = true;
      this.proc.stdin.write(JSON.stringify({ id: `p${++this.seq}`, type: "prompt", message }) + "\n");
    });
  }
  stop() { if (this.proc) { try { this.proc.kill("SIGKILL"); } catch {} this.proc = null; } }
}

const pi = new PiSession();
pi.start();

/* ------------------------------------------------------------------ tts */

async function synthesize(text, voice, language) {
  const r = await fetch(`${AUDIO}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: TTS_MODEL, input: text, voice: voice || TTS_VOICE, language: language || TTS_LANG }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const pcm = wavToPCM(new Uint8Array(await r.arrayBuffer()));
  return { bytes: pcm.bytes, rate: pcm.rate };
}

/* ------------------------------------------------------------------ sentence buffer */

// Accumulate deltas and release complete sentences so TTS is never fed fragments.
class SentenceSplitter {
  constructor(onSentence) { this.buf = ""; this.onSentence = onSentence; }
  push(delta) {
    this.buf += delta;
    // Deterministic scan (no regex): emit at the first real sentence end, or a blank line.
    // A "." only ends a sentence when the next char is space/EOF/newline AND it is not part
    // of a decimal/version ("1.1"), an abbreviation, or a path. Everything else keeps buffering.
    const ABBREV = /(?:\b(?:e\.g|i\.e|etc|vs|Mr|Dr|St|approx|no|fig)\.)$/i;
    for (;;) {
      let cut = -1;
      for (let i = 0; i < this.buf.length; i++) {
        const ch = this.buf[i];
        if (ch === "\n") {
          const nl = this.buf.slice(0, i);
          if (nl.trim() === "" ) { continue; }              // leading blank line
          cut = i + 1; break;                               // treat newline as a boundary
        }
        if (ch === "." || ch === "!" || ch === "?") {
          const next = this.buf[i + 1];
          if (next === undefined) break;                    // wait for more input
          if (ch === "." && /\d/.test(next)) continue;      // 1.1
          if (ch === "." && /\d/.test(this.buf[i - 1])) continue;
          if (next !== " " && next !== "\n" && next !== "\t") continue;
          if (ch === "." && ABBREV.test(this.buf.slice(0, i + 1))) continue;
          if (ch === "." && this.buf[i - 1] === ".") continue;
          cut = i + 1; break;
        }
      }
      if (cut < 0) break;
      const head = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut).trimStart();
      if (head) this.onSentence(head);
    }
    // A very long run with no boundary: cut at the last clause boundary, never mid-word.
    if (this.buf.length > 260) {
      let cut = Math.max(this.buf.lastIndexOf(", ", 200), this.buf.lastIndexOf("; ", 200), this.buf.lastIndexOf(" — ", 200), this.buf.lastIndexOf(" ", 200));
      if (cut < 60) cut = this.buf.lastIndexOf(" ", 220);
      if (cut < 30) cut = 200;
      const head = this.buf.slice(0, cut).trim().replace(/[,;]$/, "");
      this.buf = this.buf.slice(cut).replace(/^[\s,;]+/, "");
      if (head) this.onSentence(head);
    }
  }
  flush() { const s = this.buf.trim(); this.buf = ""; if (s) this.onSentence(s); }
}

/* ------------------------------------------------------------------ http */

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

let lastTurn = null;

// POST /bridge/chat {text, voice?, language?}
// Same pi turn as /bridge/reply, but the client gets an SSE stream of JSON events
// instead of raw PCM, so a UI can show (and curate) the full answer, not just hear it:
//   {type:"text.delta", text}      raw assistant delta, as it streams
//   {type:"sentence", text}        the exact sentence just queued for speech
//   {type:"audio", data, rate}     base64 s16le mono PCM, one event per sentence
//   {type:"done", text, spoken, ms}  text = full (unabridged) assistant text
//   {type:"error", message}
async function serveChat(res, transcript, ttsVoice, ttsLang) {
  const t0 = Date.now();
  let closed = false;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
  const emit = ev => { if (!closed && !res.writableEnded) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} } };

  let fullText = "";
  let spoken = "";
  let cueSent = false;
  const speechQueue = [];
  let pumping = false;

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (speechQueue.length) {
        const s = speechQueue.shift();
        try { const { bytes, rate } = await synthesize(s, ttsVoice, ttsLang); console.log(`[tts-out] rate=${rate} bytes=${bytes.length}`); emit({ type: "audio", data: Buffer.from(bytes).toString("base64"), rate }); }
        catch (e) { console.error("[tts]", e.message); }
      }
    } finally { pumping = false; }
  }
  const speak = s => { emit({ type: "sentence", text: s }); speechQueue.push(s); pump(); };

  const cueTimer = setTimeout(() => {
    if (spoken || cueSent) return;
    cueSent = true;
    speak(WORKING_CUE);
  }, FIRST_SENTENCE_MS);

  try {
    const splitter = new SentenceSplitter(part => {
      if (spoken.length >= MAX_TOTAL_SPOKEN) return;
      const s = speakable(part, MAX_SPOKEN_CHARS);
      if (!s) return;
      spoken += (spoken ? " " : "") + s;
      speak(s);
    });

    const text = await pi.run(transcript, {
      onDelta: d => { fullText += d; emit({ type: "text.delta", text: d }); splitter.push(d); },
      onTool: (name) => { if (!spoken && !cueSent) { cueSent = true; speak(WORKING_CUE); } },
    });
    splitter.flush();

    if (!spoken.trim()) speak(text ? "That is done. The details are on screen." : "I have no reply for that.");
    else if (text && text.length > spoken.length * 1.6) speak("The rest is on screen.");

    while (speechQueue.length || pumping) await new Promise(r => setTimeout(r, 50));

    lastTurn = { summary: spoken, ms: Date.now() - t0, at: new Date().toISOString(), transcript };
    emit({ type: "done", text, spoken, ms: Date.now() - t0 });
  } catch (e) {
    console.error("[bridge:chat]", e.message);
    emit({ type: "error", message: e.message });
  } finally {
    clearTimeout(cueTimer);
    closed = true;
    try { res.end(); } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/bridge/last") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(lastTurn || { summary: null }));
  }
  if (url.pathname === "/bridge/health" || url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, busy: pi.busy, cwd: PI_CWD, tts: `${TTS_MODEL}/${TTS_VOICE}` }));
  }
  if ((url.pathname !== "/bridge/reply" && url.pathname !== "/bridge/chat") || req.method !== "POST") {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  if (pi.busy) {
    res.writeHead(409, { "content-type": "text/plain" });
    return res.end("busy: a pi turn is already running");
  }

  let transcript = "", ttsVoice = "", ttsLang = "";
  try {
    const b = JSON.parse(await readBody(req) || "{}");
    transcript = (b.text || "").trim();
    ttsVoice = typeof b.voice === "string" ? b.voice : "";
    ttsLang = typeof b.language === "string" ? b.language : "";
  } catch {}
  if (!transcript) { res.writeHead(400, { "content-type": "text/plain" }); return res.end("missing text"); }

  if (url.pathname === "/bridge/chat") return serveChat(res, transcript, ttsVoice, ttsLang);

  const t0 = Date.now();
  let headersSent = false;
  let spoken = "";
  let cueSent = false;
  const speechQueue = [];      // sentences awaiting synthesis
  let pumping = false;

  const sendChunk = bytes => { try { if (!res.writableEnded) res.write(Buffer.from(bytes)); } catch {} };

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (speechQueue.length) {
        const s = speechQueue.shift();
        try { const { bytes, rate } = await synthesize(s, ttsVoice, ttsLang); console.log(`[tts-out] rate=${rate} bytes=${bytes.length}`); sendChunk(bytes); }
        catch (e) { console.error("[tts]", e.message); }
      }
    } finally { pumping = false; }
  }
  const speak = s => { console.log("[speak]", s.length, JSON.stringify(s)); speechQueue.push(s); pump(); };

  // "working on it" cue if pi is slow to say anything speakable (tool-heavy turns)
  const cueTimer = setTimeout(() => {
    if (spoken || cueSent) return;
    cueSent = true;
    speak(WORKING_CUE);
  }, FIRST_SENTENCE_MS);

  try {
    // Stream headers immediately so the browser starts buffering audio.
    res.writeHead(200, {
      "content-type": "audio/L16;rate=24000",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    headersSent = true;

    const splitter = new SentenceSplitter(part => {
      if (process.env.BRIDGE_DEBUG === "1") console.error("[part] " + JSON.stringify(part.slice(0, 200)));
      if (spoken.length >= MAX_TOTAL_SPOKEN) return;   // enough for voice; the rest is on screen
      const s = speakable(part, MAX_SPOKEN_CHARS);
      if (!s) return;
      spoken += (spoken ? " " : "") + s;
      speak(s);
    });

    const text = await pi.run(transcript, {
      onDelta: d => splitter.push(d),
      onTool: (name) => { if (!spoken && !cueSent) { cueSent = true; speak(WORKING_CUE); } },
    });
    splitter.flush();

    // if pi produced nothing speakable, say so rather than going silent
    if (!spoken.trim()) speak(text ? "That is done. The details are on screen." : "I have no reply for that.");
    else if (text && text.length > spoken.length * 1.6) speak("The rest is on screen.");

    // drain the speech queue before closing
    while (speechQueue.length || pumping) await new Promise(r => setTimeout(r, 50));

    lastTurn = { summary: spoken, ms: Date.now() - t0, at: new Date().toISOString(), transcript };
    res.end();
  } catch (e) {
    console.error("[bridge]", e.message);
    if (!headersSent) {
      res.writeHead(e.message.includes("timed out") ? 504 : 502, { "content-type": "text/plain" });
      res.end(e.message);
    } else { try { res.end(); } catch {} }
  } finally {
    clearTimeout(cueTimer);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`pi-audio-bridge (bridge.mjs) on http://${HOST}:${PORT}  (pi cwd ${PI_CWD}, tts ${TTS_MODEL}/${TTS_VOICE})`);
});
