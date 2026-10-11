"use strict";
/* pi — talk: one-button mobile voice UX.
 * hold = record, release = send (ASR -> pi -> streamed TTS), press = stop.
 * Status line is driven by server events: ASR is local-then-sent, /bridge/chat SSE
 * (text.delta / sentence / audio / done) maps 1:1 to what the user should see.
 */

/* ================= config (same presets as the chat app) ================= */
const ASR_MODEL = "nemotron-asr";
const IN_LANGS = [
  ["auto", "🌐 auto"], ["en-US", "English"], ["en-GB", "English (UK)"], ["fr-FR", "Français"],
  ["es-ES", "Español"], ["de-DE", "Deutsch"], ["it-IT", "Italiano"], ["pt-BR", "Português"],
];
const OUT_LANGS = {
  "en-us": { label: "English", voice: "af_heart" },
  "en-gb": { label: "English (UK)", voice: "bf_emma" },
  "es":    { label: "Español", voice: "ef_dora" },
  "fr-fr": { label: "Français", voice: "ff_siwis" },
  "it":    { label: "Italiano", voice: "if_sara" },
  "pt-br": { label: "Português", voice: "pf_dora" },
  "hi":    { label: "हिन्दी", voice: "hf_alpha" },
  "zh":    { label: "中文", voice: "zf_xiaobei" },
};
const lang = { in: "auto", out: "en-us" };
const qp = new URLSearchParams(location.search);
if (qp.get("in") && IN_LANGS.some(([v]) => v === qp.get("in"))) lang.in = qp.get("in");
if (qp.get("out") && OUT_LANGS[qp.get("out").toLowerCase()]) lang.out = qp.get("out").toLowerCase();
const selIn = document.getElementById("langIn"), selOut = document.getElementById("langOut");
selIn.innerHTML = IN_LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
selOut.innerHTML = Object.entries(OUT_LANGS).map(([v, o]) => `<option value="${v}">${o.label}</option>`).join("");
selIn.value = lang.in; selOut.value = lang.out;
selIn.onchange = () => { lang.in = selIn.value; };
selOut.onchange = () => { lang.out = selOut.value; };

const $ = id => document.getElementById(id);
const statusEl = $("status"), subEl = $("sub"), ptt = $("ptt"),
      pttIco = $("pttIco"), pttLbl = $("pttLbl"), ring = $("ring"),
      answer = $("answer"), ansText = $("ansText"), youLine = $("youLine"),
      healthEl = $("health");

/* ================= state ================= */
let state = "idle";            // idle | rec | asr | turn
let turnAbort = null;
let recFrames = [], recStart = 0, recTimer = null, recLevel = 0;
const MAX_REC_S = 30;

function setStatus(cls, text, sub) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
  subEl.textContent = sub || "";
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function toIdle(subMsg) {
  state = "idle";
  ptt.classList.remove("rec", "stop");
  pttIco.textContent = "🎙"; pttLbl.textContent = "hold to talk";
  ring.style.opacity = 0;
  if (subMsg) setStatus("", "Hold the button and talk", subMsg);
}
function newTurnUI(transcript) {
  ansText.innerHTML = "";
  youLine.innerHTML = `<b>You:</b> ${escapeHtml(transcript)}`;
  youLine.hidden = false;
}
function appendAnswer(text) {
  ansText.textContent += text;
  const cur = document.createElement("span"); cur.className = "cur";
  ansText.appendChild(cur);
  answer.scrollTop = answer.scrollHeight;
}
function answerDone() {
  const cur = ansText.querySelector(".cur");
  if (cur) cur.remove();
}

/* ================= playback engine (WebAudio, resampled) ================= */
function makeRes(inHz, outHz) {
  const r = inHz / outHz; let frac = 0;
  return f => {
    const total = Math.floor((frac + f.length) / r);
    const out = new Array(Math.max(0, total));
    for (let o = 0; o < total; o++) {
      const x = o * r - frac;
      const i0 = Math.min(Math.floor(x), f.length - 1);
      let s = 0, w = 0;
      for (let d = -1; d <= 2; d++) {
        const idx = i0 + d;
        if (idx < 0 || idx >= f.length) continue;
        const tri = Math.max(0, 1 - Math.abs(x - idx));
        if (tri <= 0) continue;
        s += f[idx] * tri; w += tri;
      }
      out[o] = w ? s / w : 0;
    }
    frac = (frac + f.length - total * r) % r;
    return out;
  };
}
let ctxOut = null, resOut = null, resOutRate = 0, outQ = [], outUntil = 0, activeSrcs = [];
function ensureOut() {
  if (!ctxOut) { ctxOut = new AudioContext(); if (ctxOut.state === "suspended") ctxOut.resume(); }
  return ctxOut;
}
function isPlaying() { return !!ctxOut && outUntil > ctxOut.currentTime; }
function playBytes(bytes, rate) {
  const ctx = ensureOut();
  if (!resOut || resOutRate !== rate) { resOut = makeRes(rate, ctx.sampleRate); resOutRate = rate; }
  const n = Math.floor(bytes.byteLength / 2);
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, n);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = i16[i] / 32768;
  const out = Float32Array.from(resOut(f));
  const ab = ctx.createBuffer(1, Math.max(1, out.length), ctx.sampleRate);
  ab.getChannelData(0).set(out);
  outQ.push(ab); tickOut();
}
function tickOut() {
  const ctx = ctxOut; if (!ctx) return;
  if (outUntil < ctx.currentTime + 0.15) {
    while (outQ.length && outUntil < ctx.currentTime + 0.35) {
      const ab = outQ.shift();
      const s = ctx.createBufferSource();
      s.buffer = ab; s.connect(ctx.destination);
      s.start(Math.max(ctx.currentTime + 0.02, outUntil));
      outUntil = Math.max(outUntil, ctx.currentTime) + ab.duration;
      activeSrcs.push(s);
      if (activeSrcs.length > 12) activeSrcs.splice(0, activeSrcs.length - 12);
    }
  }
  if (outQ.length || isPlaying()) setTimeout(tickOut, 100);
}
function stopPlayback() {
  outQ = [];
  activeSrcs.forEach(s => { try { s.stop(); } catch (e) {} });
  activeSrcs = []; outUntil = 0;
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/* ================= mic capture (16 kHz mono, resampled worklet) ================= */
const IN_RATE = 16000, CAPTURE_CHUNK = 2048;
let micOn = false, ctxIn = null, mediaStream = null, srcNode = null, workletNode = null;
let res16 = null;
const workletSrc = `
class MicBuf extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${CAPTURE_CHUNK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(this.buf.length); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('micbuf', MicBuf);`;
async function ensureMic() {
  if (micOn) return;
  ensureOut();                                    // inside the press gesture: unlock audio
  ctxIn = new AudioContext();
  if (ctxIn.state === "suspended") await ctxIn.resume();
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const url = URL.createObjectURL(new Blob([workletSrc], { type: "application/javascript" }));
  await ctxIn.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  srcNode = ctxIn.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(ctxIn, "micbuf");
  workletNode.port.onmessage = e => onMicFrame(e.data);
  const sink = ctxIn.createGain(); sink.gain.value = 0;
  srcNode.connect(workletNode); workletNode.connect(sink); sink.connect(ctxIn.destination);
  res16 = makeRes(ctxIn.sampleRate, IN_RATE);
  micOn = true;
}
function onMicFrame(f) {
  if (!micOn) return;
  if (state !== "rec") return;
  const f16 = res16(f);
  recFrames.push(f16);
  // level meter: RMS -> ring opacity, updated per 100 ms frame
  let s = 0; for (let i = 0; i < f16.length; i++) s += f16[i] * f16[i];
  const rms = Math.sqrt(s / f16.length);
  const pct = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-9) + 48) / 48));
  recLevel = pct;
  const deg = Math.round(pct * 360);
  ring.style.opacity = 1;
  ring.style.background = `conic-gradient(#e8655a ${deg}deg, transparent ${deg}deg)`;
  const el = (performance.now() - recStart) / 1000;
  pttLbl.textContent = el.toFixed(0) + "s";
}

/* ================= record -> wav ================= */
function trimSilence(f) {
  const TH = Math.pow(10, -45 / 20), WIN = 160, PAD = 4800;   // -45 dBFS, 10 ms win, 300 ms pad
  const loud = i => {
    let s = 0; const end = Math.min(i + WIN, f.length);
    for (let j = i; j < end; j++) s += f[j] * f[j];
    return Math.sqrt(s / WIN) > TH;
  };
  let a = 0; while (a < f.length - PAD && !loud(a)) a += WIN;
  let b = f.length - 1; while (b > a + PAD && !loud(b - WIN)) b -= WIN;
  return f.slice(Math.max(0, a - WIN), Math.min(f.length, b + PAD));
}
function pcmToWavBytes(f) {
  const n = f.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const ws = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, IN_RATE, true); v.setUint32(28, IN_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767))), true);
  return new Uint8Array(buf);
}
function concatFrames(frames) {
  const total = frames.reduce((s, f) => s + f.length, 0);
  const out = new Float32Array(total); let o = 0;
  for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
}

/* ================= ASR (audio.cpp via same-origin proxy) ================= */
async function transcribe(f16) {
  const fd = new FormData();
  fd.append("file", new Blob([pcmToWavBytes(f16)], { type: "audio/wav" }), "utt.wav");
  fd.append("model", ASR_MODEL);
  if (lang.in !== "auto") fd.append("language", lang.in);
  const resp = await fetch("/v1/audio/transcriptions", { method: "POST", body: fd });
  if (!resp.ok) throw new Error("asr " + resp.status);
  const d = await resp.json();
  return (d.text || "").trim();
}

/* ================= bridge turn (SSE from /bridge/chat) ================= */
async function readSSE(resp, onEvent) {
  const dec = new TextDecoder();
  const reader = resp.body.getReader();
  let rem = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rem += dec.decode(value, { stream: true });
    let i;
    while ((i = rem.indexOf("\n\n")) >= 0) {
      const block = rem.slice(0, i); rem = rem.slice(i + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const p = line.slice(6);
        if (p === "[DONE]") return;
        try { onEvent(JSON.parse(p)); } catch (e) {}
      }
    }
  }
}
async function sendTurn(text) {
  state = "turn";
  turnAbort = new AbortController();
  const out = OUT_LANGS[lang.out];
  setStatus("waiting", "Thinking", "pi is working on your request");
  let sawText = false, sawAudio = false, finished = false;
  const finish = () => {
    if (finished) return; finished = true;
    answerDone();
    if (state === "turn") toIdle();   // don't clobber a newer state (e.g. user already re-pressed)
  };
  try {
    const resp = await fetch("/bridge/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: out.voice, language: lang.out }),
      signal: turnAbort.signal,
    });
    if (resp.status === 409) { setStatus("err", "pi is busy", "a turn is already running — wait or pull to refresh"); finish(); return; }
    if (!resp.ok) throw new Error("bridge " + resp.status);
    await readSSE(resp, ev => {
      if (state !== "turn") return;
      switch (ev.type) {
        case "text.delta":
          if (!sawText) { sawText = true; setStatus("", "Answering"); }
          appendAnswer(ev.text);
          break;
        case "sentence":
          if (!sawAudio) subEl.textContent = "synthesizing speech…";
          break;
        case "audio":
          if (!sawAudio) { sawAudio = true; setStatus("speaking", "Speaking", ""); }
          playBytes(b64ToBytes(ev.data), ev.rate);
          break;
        case "done":
          setStatus("", "Done", ev.ms ? (ev.ms / 1000).toFixed(1) + " s end to end" : "");
          finish();
          break;
        case "error":
          setStatus("err", "Error", ev.message || "unknown");
          finish();
          break;
      }
    });
    if (state === "turn") { if (!sawAudio) subEl.textContent = ""; finish(); }
  } catch (e) {
    if (e.name !== "AbortError" && state === "turn") setStatus("err", "Error", e.message);
    finish();
  }
}

/* ================= press / release ================= */
async function press() {
  ensureOut();                       // must run inside the gesture for autoplay policy
  if (isPlaying()) { stopPlayback(); subEl.textContent = "stopped"; return; }
  if (state === "turn") {            // cancel an in-flight turn
    if (turnAbort) turnAbort.abort();
    stopPlayback();
    toIdle("stopped — the turn may finish in the background");
    return;
  }
  if (state !== "idle") return;
  try {
    await ensureMic();
  } catch (e) {
    setStatus("err", "Mic unavailable", e.message + " — check permissions / HTTPS");
    return;
  }
  stopPlayback();
  state = "rec";
  recFrames = []; recStart = performance.now(); recLevel = 0;
  ptt.classList.add("rec");
  pttIco.textContent = "⏺"; pttLbl.textContent = "0s";
  setStatus("rec", "Listening", "release when you are done");
  recTimer = setTimeout(release, MAX_REC_S * 1000);   // auto-release, never stuck
}
async function release() {
  if (state !== "rec") return;
  clearTimeout(recTimer); recTimer = null;
  const raw = concatFrames(recFrames); recFrames = [];
  ptt.classList.remove("rec"); pttIco.textContent = "🎙"; pttLbl.textContent = "hold to talk";
  ring.style.opacity = 0;
  const dur = raw.length / IN_RATE;
  if (dur < 0.4) { toIdle("too short — hold a bit longer"); return; }
  const f = trimSilence(raw);
  if (f.length / IN_RATE < 0.25) { toIdle("only silence — hold the button and speak"); return; }
  state = "asr";
  setStatus("waiting", "Transcribing", "turning your voice into text…");
  let text = "";
  try {
    text = await transcribe(f);
  } catch (e) {
    state = "idle";
    setStatus("err", "Transcription failed", e.message);
    return;
  }
  if (state !== "asr") return;
  if (!text) { toIdle("didn't catch that — hold the button and try again"); return; }
  newTurnUI(text);
  sendTurn(text);
}
// pointer events: down on the button, up anywhere (release even if the finger drifts)
ptt.addEventListener("pointerdown", e => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); press(); });
ptt.addEventListener("pointerup", e => { e.preventDefault(); release(); });
ptt.addEventListener("pointercancel", e => { e.preventDefault(); release(); });
// keyboard for desktop testing
document.addEventListener("keydown", e => { if (e.code === "Space" && !e.repeat) { e.preventDefault(); press(); } });
document.addEventListener("keyup", e => { if (e.code === "Space") { e.preventDefault(); release(); } });

/* ================= health (server liveness in the header) ================= */
async function pollHealth() {
  try {
    const r = await fetch("/bridge/health");
    const h = await r.json();
    healthEl.textContent = `kokoro · ${h.busy ? "busy" : "ready"}`;
    healthEl.style.color = h.busy ? "#e5b94c" : "";
  } catch {
    healthEl.textContent = "bridge offline";
    healthEl.style.color = "#e8655a";
  }
}
pollHealth();
setInterval(pollHealth, 4000);
