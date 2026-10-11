"use strict";
/* pi — chat: UI, turn flow, curation (uses globals from chat-audio.js) */

/* ---------- tiny helpers ---------- */
const msgsEl = $("msgs");
function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function setListen(text) { const l = $("listen"); l.textContent = text ? "… " + text : ""; l.classList.toggle("live", !!text); }
function setStatus(t) { $("status").textContent = t; }
function scroll() { const c = $("chat"); c.scrollTop = c.scrollHeight; }
function hideHero() { const h = $("hero"); if (h) h.style.display = "none"; }

/* ---------- curation store (localStorage) ---------- */
const CS_KEY = "piChatCuration.v1";
let cs = null;
try { cs = JSON.parse(localStorage.getItem(CS_KEY)); } catch (e) {}
if (!cs || !Array.isArray(cs.items)) cs = { items: [] };
function saveCS() {
  try { localStorage.setItem(CS_KEY, JSON.stringify(cs)); } catch (e) {}
  $("curcount").textContent = cs.items.length;
}
function findItem(id) { return cs.items.find(i => i.id === id); }
function storeItem(msg) {
  const item = { id: msg.id, at: new Date().toISOString(), q: msg.q, a: msg.text, spoken: msg.spoken, rating: 0, pinned: false, note: "" };
  cs.items.unshift(item);
  if (cs.items.length > 200) cs.items.length = 200;
  saveCS();
  return item;
}

/* ---------- messages ---------- */
const session = new Map();   // id -> {id,q,text,spoken,chunks,rate,done,err,row,bub,acts,item}
function addRow(who) {
  hideHero();
  const row = el(`<div class="msg ${who}"><div class="av">${who === "me" ? "🫵" : "π"}</div><div style="display:flex;flex-direction:column;max-width:74%"><div class="bub"></div></div></div>`);
  msgsEl.appendChild(row);
  scroll();
  return row;
}
function addUser(text, voice) {
  const row = addRow("me");
  const bub = row.querySelector(".bub");
  bub.textContent = text;
  if (voice) bub.insertAdjacentHTML("beforeend", '<span class="src">🎙 voice</span>');
}
function addPi() {
  const row = addRow("pi");
  row.querySelector(".bub").innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  return row;
}

/* ---------- turn flow ---------- */
let busy = false;
const pending = [];
async function sendTurn(text, opts = {}) {
  text = (text || "").trim();
  if (!text) return;
  addUser(text, opts.voice);
  if (busy) { pending.push(text); return; }
  await runTurn(text);
}
async function runTurn(text) {
  busy = true;
  setStatus("thinking…");
  const row = addPi();
  const bub = row.querySelector(".bub");
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const msg = { id, q: text, text: "", spoken: "", chunks: [], rate: 0, done: false, err: false, row, bub, acts: null, item: null };
  session.set(id, msg);
  let gotAudio = false;
  try {
    const r = await fetch("/bridge/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: OUT_LANGS[lang.out].voice, language: lang.out }),
      signal: AbortSignal.timeout(240000),
    });
    if (!r.ok) throw new Error("bridge " + r.status + ": " + ((await r.text()).slice(0, 80)));
    const reader = r.body.getReader();
    const dec = new TextDecoder();
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
          let ev; try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
          if (ev.type === "text.delta") {
            const first = !msg.text;
            msg.text += ev.text;
            bub.textContent = msg.text;     // replaces the typing dots on the first delta
            if (first) setStatus("answering — speaking…");
            scroll();
          } else if (ev.type === "audio") {
            msg.chunks.push(ev.data);
            if (!msg.rate) msg.rate = ev.rate;
            playB64(ev.data, ev.rate);
            gotAudio = true;
          } else if (ev.type === "done") {
            msg.text = ev.text || msg.text;
            msg.spoken = ev.spoken || "";
          } else if (ev.type === "error") {
            throw new Error(ev.message || "bridge error");
          }
        }
      }
    }
    if (!gotAudio && !msg.text) throw new Error("no reply arrived");
    if (msg.text) bub.textContent = msg.text;
  } catch (e) {
    msg.err = true;
    bub.classList.add("err");
    bub.textContent = "oops — " + e.message;
  }
  finishMsg(msg);
  busy = false;
  setStatus("here — talk or type below");
  const next = pending.shift();
  if (next !== undefined) runTurn(next);
}
function finishMsg(msg) {
  if (msg.done) return;
  msg.done = true;
  msg.item = findItem(msg.id) || storeItem(msg);
  const acts = el(
    '<div class="acts">'
    + '<button class="r1" title="good answer">👍</button>'
    + '<button class="rm1" title="weak answer">👎</button>'
    + '<button class="pin" title="pin for curation">⭐</button>'
    + '<button class="replay" title="hear it again">↺</button>'
    + '<button class="copy" title="copy text">⧉</button>'
    + '</div>');
  msg.bub.insertAdjacentElement("afterend", acts);
  msg.acts = acts;
  const it = msg.item;
  const b = sel => acts.querySelector(sel);
  b(".r1").onclick = () => { it.rating = it.rating === 1 ? 0 : 1; saveCS(); refreshAll(); };
  b(".rm1").onclick = () => { it.rating = it.rating === -1 ? 0 : -1; saveCS(); refreshAll(); };
  b(".pin").onclick = () => { it.pinned = !it.pinned; saveCS(); refreshAll(); };
  b(".replay").onclick = () => { if (msg.chunks.length) { stopPlayback(); msg.chunks.forEach(x => playB64(x, msg.rate)); } };
  b(".copy").onclick = () => navigator.clipboard.writeText(msg.text);
  syncActs(msg);
  scroll();
}
function syncActs(msg) {
  if (!msg.acts || !msg.item) return;
  const a = msg.acts, it = msg.item;
  a.querySelector(".r1").classList.toggle("on", it.rating === 1);
  a.querySelector(".rm1").classList.toggle("on", it.rating === -1);
  a.querySelector(".pin").classList.toggle("on", !!it.pinned);
}
function syncAllActs() { for (const m of session.values()) syncActs(m); }
function refreshAll() { renderDrawer(); syncAllActs(); }

/* ---------- curation drawer ---------- */
let dFilter = "all";
function openDrawer() { document.body.classList.add("curated"); renderDrawer(); }
function closeDrawer() { document.body.classList.remove("curated"); }
function renderDrawer() {
  const body = $("dbody");
  const items = cs.items.filter(it =>
    dFilter === "all" ? true : dFilter === "pin" ? it.pinned : it.rating === Number(dFilter));
  body.innerHTML = "";
  if (!items.length) {
    body.innerHTML = '<div class="dempty">Nothing here yet.<br>Rate an answer 👍/👎 or pin it ⭐<br>and it will wait for you in the next curation round.</div>';
    return;
  }
  for (const it of items) {
    const card = el(`<div class="citem${it.pinned ? " pin" : ""}">
      <div class="q"></div><div class="a"></div>
      <div class="meta">
        <button class="r1" title="good">👍</button><button class="rm1" title="weak">👎</button><button class="pin" title="pin">⭐</button>
        <input type="text" placeholder="note…">
        <span class="at"></span><button class="del" title="delete">🗑</button>
      </div></div>`);
    card.querySelector(".q").textContent = it.q;
    card.querySelector(".a").textContent = it.a || "(no text)";
    const note = card.querySelector("input");
    note.value = it.note || "";
    card.querySelector(".at").textContent = new Date(it.at).toLocaleString();
    const r1 = card.querySelector(".r1"), rm1 = card.querySelector(".rm1"), pin = card.querySelector(".pin"), del = card.querySelector(".del");
    if (it.rating === 1) r1.classList.add("on");
    if (it.rating === -1) rm1.classList.add("on");
    if (it.pinned) pin.classList.add("on");
    r1.onclick = () => { it.rating = it.rating === 1 ? 0 : 1; saveCS(); renderDrawer(); syncAllActs(); };
    rm1.onclick = () => { it.rating = it.rating === -1 ? 0 : -1; saveCS(); renderDrawer(); syncAllActs(); };
    pin.onclick = () => { it.pinned = !it.pinned; saveCS(); renderDrawer(); syncAllActs(); };
    del.onclick = () => { cs.items = cs.items.filter(x => x.id !== it.id); saveCS(); renderDrawer(); };
    note.oninput = () => { it.note = note.value; saveCS(); };
    body.appendChild(card);
  }
}
function dl(name, text, mime) {
  const b = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function mdExport() {
  const mark = it => it.pinned ? "⭐" : it.rating === 1 ? "✅" : it.rating === -1 ? "🕵️" : "•";
  let out = `# pi curation — ${new Date().toLocaleString()}\n\n${cs.items.length} answer(s)\n`;
  for (const it of cs.items) {
    out += `\n---\n\n${mark(it)} **you:** ${it.q}\n\n${it.a || "(no text)"}\n`;
    if (it.spoken) out += `\n> spoken: ${it.spoken}\n`;
    if (it.note) out += `\n_note: ${it.note}_\n`;
  }
  return out;
}

/* ---------- wiring ---------- */
function onPlayState() { $("stopall").classList.toggle("show", isPlaying()); }   // overrides the no-op in chat-audio.js
function userSpoke(text) { sendTurn(text, { voice: true }); }                     // called by the mic engine
async function toggleMic() {
  if (micOn) { stopMic(); return; }
  try { await startMic(); setStatus("listening — say hi"); }
  catch (e) { setStatus("mic unavailable: " + e.message); }
}
$("curbtn").onclick = openDrawer;
$("curclose").onclick = closeDrawer;
$("shade").onclick = closeDrawer;
$("dfilters").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  dFilter = b.dataset.f;
  [...$("dfilters").children].forEach(x => x.classList.toggle("on", x === b));
  renderDrawer();
});
$("expmd").onclick = () => dl("pi-curation.md", mdExport(), "text/markdown");
$("expjs").onclick = () => dl("pi-curation.json", JSON.stringify(cs, null, 2), "application/json");
$("clearall").onclick = () => { if (confirm("Delete all curation items?")) { cs.items = []; saveCS(); renderDrawer(); } };
$("micbtn").onclick = toggleMic;
$("micpill").onclick = toggleMic;
$("startvoice").onclick = toggleMic;
$("stopall").onclick = stopPlayback;
function sendFromField() { const t = $("field").value; if (t.trim()) { $("field").value = ""; sendTurn(t); } }
$("sendbtn").onclick = sendFromField;
$("field").addEventListener("keydown", e => { if (e.key === "Enter") sendFromField(); });
saveCS();   // renders the badge
$("field").focus();
