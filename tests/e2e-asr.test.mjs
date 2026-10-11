// Tier-2 e2e: ASR. q16k.wav goes through the real server.mjs proxy to the real
// audio.cpp — the exact request shape the browser sends (web/main/index.html asrForm).
// Auto-skips when audio.cpp is not running or the local fixture is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, API_PORT, backendUp, startServer } from "./e2e/helpers.mjs";

const ASR_MODEL = "nemotron-asr";

async function setup(t) {
  if (!(await backendUp(`http://127.0.0.1:${API_PORT}/health`))) { t.skip("audio.cpp not running"); return null; }
  const wavPath = path.join(ROOT, "q16k.wav");
  if (!fs.existsSync(wavPath)) { t.skip("q16k.wav fixture absent"); return null; }
  const srv = await startServer();
  t.after(() => srv.kill());
  return { srv, wavPath };
}

test("e2e ASR: final transcription of q16k.wav through server proxy", async t => {
  const s = await setup(t);
  if (!s) return;

  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(s.wavPath)], { type: "audio/wav" }), "utt.wav");
  form.append("model", ASR_MODEL);

  const r = await fetch(`${s.srv.base}/v1/audio/transcriptions`, {
    method: "POST", body: form, signal: AbortSignal.timeout(30000),
  });
  assert.equal(r.status, 200);
  const text = ((await r.json()).text || "").trim();
  assert.ok(text.length > 0, "expected non-empty transcript");
});

test("e2e ASR: stream=true emits SSE transcript deltas", async t => {
  const s = await setup(t);
  if (!s) return;

  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(s.wavPath)], { type: "audio/wav" }), "utt.wav");
  form.append("model", ASR_MODEL);
  form.append("stream", "true");

  const r = await fetch(`${s.srv.base}/v1/audio/transcriptions`, {
    method: "POST", body: form, signal: AbortSignal.timeout(30000),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  const body = await r.text();
  assert.match(body, /transcript\.text\.delta/);
});
