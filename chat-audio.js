"use strict";
/* pi — chat: shared audio + mic engine (loaded before chat.js; classic scripts share the global scope) */
const ASR_MODEL = "nemotron-asr", TTS_MODEL = "kokoro-tts";
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
const $ = id => document.getElementById(id);
const db = r => 20 * Math.log10(r + 1e-9);
const rmsOf = f => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / f.length); };
function initLang() {
  const selIn = $("langIn"), selOut = $("langOut");
  selIn.innerHTML = IN_LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  selOut.innerHTML = Object.entries(OUT_LANGS).map(([v, o]) => `<option value="${v}">${o.label}</option>`).join("");
  const qp = new URLSearchParams(location.search);
  if (qp.get("in") && IN_LANGS.some(([v]) => v === qp.get("in"))) lang.in = qp.get("in");
  if (qp.get("out") && OUT_LANGS[qp.get("out").toLowerCase()]) lang.out = qp.get("out").toLowerCase();
  selIn.value = lang.in; selOut.value = lang.out;
  selIn.onchange = () => { lang.in = selIn.value; syncLangURL(); };
  selOut.onchange = () => { lang.out = selOut.value; syncLangURL(); };
  syncLangURL();
}
function syncLangURL() {
  const p = new URLSearchParams();
  if (lang.in !== "auto") p.set("in", lang.in);
  p.set("out", lang.out);
  history.replaceState(null, "", "?" + p.toString());
}
const asrURL = () => `/v1/audio/transcriptions/live?model=${ASR_MODEL}` + (lang.in !== "auto" ? `&language=${lang.in}` : "");

/* ---------------- playback (same engine as the voice app) ---------------- */
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
  onPlayState();
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
  activeSrcs = []; outUntil = 0; bargeN = 0;
  onPlayState();
}
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function playB64(b64, rate) { playBytes(b64ToBytes(b64), rate); }
// chat.js implements onPlayState() (shows the ■ stop button); default no-op
function onPlayState() {}
setInterval(() => { try { onPlayState(); } catch (e) {} }, 500);   // keep the stop button in sync

/* ---------------- mic capture + VAD (same engine as the voice app) ---------------- */
const IN_RATE = 16000, FRAME_MS = 100, CAPTURE_CHUNK = 2048;
const BARGE_DBFS = -30, SILENCE_MS = 800, MAX_UTTERANCE_S = 30, PARTIAL_MS = 900, MIN_UTTERANCE_S = 0.35;
let micOn = false, ctxIn = null, mediaStream = null, srcNode = null, workletNode = null, sinkGain = null, res16 = null;
let bargeN = 0;
const bState = { open: false, pcm: [], sent: 0, silMs: 0, gen: 0, timer: null, inFlight: false };
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
async function startMic() {
  if (micOn) return;
  ensureOut();                                   // user gesture: unlock audio
  ctxIn = new AudioContext();
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const url = URL.createObjectURL(new Blob([workletSrc], { type: "application/javascript" }));
  await ctxIn.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  srcNode = ctxIn.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(ctxIn, "micbuf");
  workletNode.port.onmessage = e => onFrame(e.data, ctxIn.sampleRate);
  sinkGain = ctxIn.createGain(); sinkGain.gain.value = 0;
  srcNode.connect(workletNode); workletNode.connect(sinkGain); sinkGain.connect(ctxIn.destination);
  res16 = makeRes(ctxIn.sampleRate, IN_RATE);
  micOn = true; setMicUI(true);
}
function stopMic() {
  micOn = false;
  if (bState.open) closeUtterance();
  try { workletNode && (workletNode.port.onmessage = null, workletNode.disconnect()); } catch (e) {}
  try { srcNode && srcNode.disconnect(); } catch (e) {}
  try { sinkGain && sinkGain.disconnect(); } catch (e) {}
  workletNode = srcNode = sinkGain = null;
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (ctxIn) { ctxIn.close(); ctxIn = null; }
  setMicUI(false);
  setListen("");
}
function setMicUI(on) {
  $("micbtn").classList.toggle("on", on);
  $("micpill").classList.toggle("on", on);
  $("miclabel").textContent = on ? "listening…" : "mic off";
}
function onFrame(f, nativeRate) {
  if (!micOn) return;
  const rms = rmsOf(f);
  $("lvl").style.width = Math.min(100, Math.max(0, (db(rms) + 48) / 48 * 100)) + "%";
  if (isPlaying() && db(rms) > BARGE_DBFS) { if (++bargeN >= 3) { stopPlayback(); bargeN = 0; } } else bargeN = 0;
  const f16 = res16(f);
  pushInput(f16, f16.length / IN_RATE * 1000);
}
function toS16(f) {
  const b = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) b[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
  return new Uint8Array(b.buffer);
}
function pushInput(f16, dtMs = FRAME_MS) {
  if (!f16.length) return;
  const loud = db(rmsOf(f16)) > BARGE_DBFS + 6;
  if (!bState.open && loud) openUtterance();
  if (bState.open) { bState.pcm.push(...f16); bState.sent += f16.length; }
  bState.silMs = loud ? 0 : bState.silMs + dtMs;
  if (bState.open && (bState.silMs > SILENCE_MS || bState.sent > MAX_UTTERANCE_S * IN_RATE)) closeUtterance();
}
function openUtterance() {
  bState.open = true; bState.pcm = []; bState.sent = 0; bState.silMs = 0;
  bState.gen++;
  const gen = bState.gen;
  bState.timer = setInterval(() => { if (bState.open && gen === bState.gen) partialUtterance(gen); }, PARTIAL_MS);
}
function closeUtterance() {
  if (!bState.open) return;
  bState.open = false;
  clearInterval(bState.timer); bState.timer = null;
  const gen = ++bState.gen;
  const pcm = bState.pcm; bState.pcm = [];
  if (pcm.length > MIN_UTTERANCE_S * IN_RATE) finalUtterance(pcm, gen);
  else setListen("");
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
function asrForm(f, stream) {
  const fd = new FormData();
  fd.append("file", new Blob([pcmToWavBytes(f)], { type: "audio/wav" }), "utt.wav");
  fd.append("model", ASR_MODEL);
  if (lang.in !== "auto") fd.append("language", lang.in);
  if (stream) fd.append("stream", "true");
  return fd;
}
async function partialUtterance(gen) {
  if (!bState.open || gen !== bState.gen || bState.inFlight) return;
  const f = bState.pcm;
  if (f.length < MIN_UTTERANCE_S * IN_RATE) return;
  bState.inFlight = true;
  let partial = "";
  try {
    const resp = await fetch("/v1/audio/transcriptions", { method: "POST", body: asrForm(f, true) });
    await readSSE(resp, ev => {
      if (gen !== bState.gen) return;
      if (ev.type === "transcript.text.delta") { partial += ev.delta; setListen(partial); }
    });
  } catch (e) {} finally { bState.inFlight = false; }
}
async function finalUtterance(pcm, gen) {
  try {
    const resp = await fetch("/v1/audio/transcriptions", { method: "POST", body: asrForm(pcm, false) });
    const d = await resp.json();
    if (gen !== bState.gen) return;
    const text = (d.text || "").trim();
    setListen("");
    if (text) userSpoke(text);          // chat.js: show bubble + start the turn
    else setListen("(didn't catch that — try again)");
  } catch (e) { if (gen === bState.gen) setListen("mic error: " + e.message); }
}
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
initLang();
