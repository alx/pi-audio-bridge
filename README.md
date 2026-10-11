# pi-audio-bridge — browser voice UI for pi

Voice in, voice out, on a single RTX 4070 (8 GB).

    mic → streaming ASR → pi bridge → TTS

| stage | model |
|---|---|
| ASR | `nemotron-asr` (streaming, 40 locales) |
| reply | `POST /bridge/reply` on this server → pi session |
| TTS | `kokoro-tts` |

No model-based routing: one fixed model per stage.
Channel A (lfm2 speech-to-speech) was **removed** on request (2026-10-09); its model was
dropped from the audio.cpp config, freeing ~1.1 GB VRAM.

## Open it

    https://<your-node>.<tailnet>.ts.net:8443/

URL parameters preset a session (shareable/bookmarkable):

    ?in=fr-FR&out=fr-fr          # French in, French out
    ?in=auto&out=en-us          # default

| param | meaning |
|---|---|
| `in` | ASR input language: an `nemotron-asr` locale (`fr-FR`, `en-US`, `de-DE`, …) or `auto` |
| `out` | TTS output language/voice: `en-us`, `en-gb`, `es`, `fr-fr`, `it`, `pt-br`, `hi`, `zh` |
The selectors in the page write back into the URL, so the current config is always copyable.

**Language coverage is per-stage and unequal:**
- input: `nemotron-asr` covers 40 locales; `auto` works well.
- output: kokoro's voice must match the language — the UI picks it for you
  (`fr-fr` → `ff_siwis`, `en-us` → `af_heart`, …). Verified working: en-us, en-gb, es, fr-fr,
  it, pt-br, hi, zh. **Japanese is unavailable** (kokoro's UniDic resources are not bundled in
  the GGUF).

Press **Start** (a click is required — browsers block audio without a user gesture), pick a
channel, talk. **Use headphones**: the mic otherwise hears the speakers. Playback stops
by itself as soon as you start talking (energy VAD barge-in).

## Why HTTPS + HTTP/2 (port 8443)

Chrome refuses to send a `ReadableStream` request body over HTTP/1.1 —
`net::ERR_ALPN_NEGOTIATION_FAILED`. The `/live` endpoints stream mic audio as a request
body, so the page **must** be served over TLS with ALPN `h2`.

### Getting a cert (deploy on your own infra)

The browser only grants the mic on a **secure context** (localhost or valid TLS), and the
streaming body requires ALPN `h2` — so remote access needs a *publicly trusted* cert on
your node. Two ways, no CA infrastructure required:

1. **Tailscale HTTPS certs (simplest).** In the tailnet admin console enable *HTTPS*
   certs (lets Tailscale mint Let's Encrypt certs for `<node>.<tailnet>.ts.net`). On the
   node, then:

       sudo tailscale cert <node>.<tailnet>.ts.net \
            --cert-file ./certs/server.crt --key-file ./certs/server.key

   `server.mjs --tls` picks up whatever `*.crt` sits in `certs/` (or override with the
   `TLS_CERT` / `TLS_KEY` env vars). No DNS, no open 443, no tailscaled `serve` — the
   app listens on :8443 directly.
2. **Any other public cert** (Let's Encrypt via your DNS, Caddy, etc.) — point DNS at the
   node (or a tunnel into the tailnet), drop the pair where `TLS_CERT`/`TLS_KEY` point.

### What the server does

- `server.mjs --tls` serves the app and proxies `/v1/*`, `/health`, `/bridge/*` to the
  local audio.cpp server (8090) / pi bridge (8092), streaming both directions (required
  for chunked uploads and SSE).
- Everything stays on the tailnet. audio.cpp has **no auth** — the tailnet is the trust
  boundary. `--cors-origins` is *not* needed (same-origin). CORS would not help anyway:
  the blocker is ALPN, not CORS.
- Upstream (audio.cpp/bridge) connections get an explicit 5-min **idle** timeout
  (`UPSTREAM_TIMEOUT_MS`). Node ≥24 otherwise arms a default 5 s idle timer on
  `http.request`, which kills `/bridge/reply` streams during long pi turns.

## Install

No npm package — clone the repo:

    git clone https://github.com/alx/pi-audio-bridge
    cd pi-audio-bridge

No build step, no dependencies (plain Node ≥ 24, ESM).

For pi — install this repo as a pi package from git (not from npm):

    pi install git:github.com/alx/pi-audio-bridge

### Audio backend on macOS (no compile step)

Verified on Apple Silicon (M2, macOS 15) with the **audio.cpp v0.9.1** prebuilt
binaries — Metal backend, no CUDA needed:

    # 1. server binary (also: macos-x64-metal, ubuntu-cpu, ubuntu-cuda…)
    curl -LO https://github.com/0xShug0/audio.cpp/releases/download/v0.9.1/audio-v0.9.1-bin-macos-arm64-metal.tar.gz
    tar xzf audio-v0.9.1-bin-macos-arm64-metal.tar.gz

    # 2. Kokoro TTS phonemizes with eSpeak-ng; the prebuilt does NOT bundle it.
    #    Without it, /v1/audio/speech fails: 500 "Could not load eSpeak-ng".
    brew install espeak-ng

    # 3. model weights (~1.1 GB) from the official GGUF repo
    curl -LO https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Nemotron-3.5-ASR-Streaming-0.6B-GGUF/nemotron-3.5-asr-streaming-0.6b-q8_0.gguf
    curl -LO https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf

    # 4. config — the model ids MUST match ASR_MODEL / TTS_MODEL in index.html
    cat > server.json <<'JSON'
    {
      "host": "127.0.0.1",
      "port": 8090,
      "backend": "metal",
      "lazy_load": true,
      "models": [
        {
          "id": "nemotron-asr",
          "family": "nemotron_asr",
          "path": "./models/nemotron-asr",
          "task": "asr",
          "mode": "streaming"
        },
        {
          "id": "kokoro-tts",
          "family": "kokoro_tts",
          "path": "./models/kokoro-tts",
          "task": "tts",
          "mode": "offline"
        }
      ]
    }
    JSON

    ./audiocpp_server --config server.json     # :8090

Note: with a non-CUDA backend the server prints that performance and model
coverage may be lower than CUDA — on M2 both stages ran well above real time
(ASR RTF ≈ 0.3, TTS ≈ 0.2).

### TTS voice/language — let the browser decide

`POST /bridge/reply` accepts optional `voice` and `language` fields; the page
sends the ones matching its `out=` selector, so French output is spoken by a
French Kokoro voice. Without this the bridge falls back to its env defaults
(`TTS_VOICE`/`TTS_LANG`, af_heart/en-us) — and an English voice phonemizing a
foreign language sounds like noise (the "working cue is fine but the reply is
garbled" symptom). `WORKING_CUE` stays English; set it via env if that annoys you.

## Run / restart

    node server.mjs            # plain HTTP/1.1 (:8091, loopback only)
    node server.mjs --tls      # HTTPS/h2, app + API proxy  (:8443)

(from the repo root; PORT/HOST env vars override the defaults in both modes.)

Audio backend (5 models, lazy-load, max 3 resident) — from the audio.cpp-bin distribution:

    audiocpp_server --config server.json

## Test without a microphone

Use **file-as-mic**: pick a 16 kHz wav (any short speech sample; `q16k.wav` is a
local, git-ignored fixture on the dev machine) and press Start. It feeds the file
through the same capture → transport → playback path at real-time pace.

On macOS the fixture can be generated with the built-in tools (no ffmpeg):

    say -o /tmp/s.aiff "Hello, this is a test."     # say -v Thomas for French
    afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/s.aiff q16k.wav

### Backend sanity checks (no microphone needed)

- **TTS→ASR round-trip**: synthesize a sentence with `/v1/audio/speech`, resample
  to 16 kHz mono, transcribe it back with `/v1/audio/transcriptions`. If the text
  comes back word-perfect, both stages (and the voice/language pairing) are good;
  if the TTS side is broken (wrong voice for the language, broken weights) you get
  garbage back. This caught the af_heart-on-French regression.
- **`/v1/audio/transcriptions/live` needs an incrementally delivered body**
  (Transfer-Encoding: chunked). `curl --data-binary @file` sends a pre-buffered
  body and is rejected with "requires an incrementally delivered body" — that's
  the endpoint telling you to stream, not a server bug.
- **nemotron-asr in streaming mode requires mono 16 kHz**
  ("streaming requires mono audio at the model sample rate"); the offline
  multipart endpoint is more permissive. Resample with
  `afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out16k.wav`.

## Tests

No dependencies — Node's built-in runner. Three tiers:

    node --test                          # tiers 1+2 (fast, safe anywhere)
    E2E_FULL=1 node --test tests/e2e-full.test.mjs   # tier 3 (live pi turn)

- **Tier 1 — hermetic** (`tests/server.test.mjs`): wav codec round-trips, routing,
  static serving, path traversal, proxy 502s — stub upstreams on ephemeral ports.
  Always runs.
- **Tier 2 — real audio.cpp** (`tests/e2e-asr.test.mjs`, `tests/e2e-tts.test.mjs`):
  q16k.wav → `/v1/audio/transcriptions` (incl. SSE `stream=true`) and
  `/v1/audio/speech` binary round-trip, both **through a spawned server.mjs**.
  Skips (not fails) when audio.cpp :8090 is down or q16k.wav is absent.
- **Tier 3 — full loop** (`tests/e2e-full.test.mjs`): `/bridge/reply` with a live
  pi session, asserting only the streamed-PCM contract (turns took 6 s to 2 min+;
  wording is never asserted). Opt-in via `E2E_FULL=1`; skips if the bridge :8092
  is down or pi is busy (409).

Skip ≠ fail: a skipped test means its backend/fixture wasn't available, and the
run still exits green.

## Transport (why this is not the /live route)

The app records each utterance locally and sends it as ordinary multipart requests to
`POST /v1/audio/transcriptions`:

- while you speak, every 900 ms the audio so far is re-sent with `stream=true` → live SSE
  deltas power the partial caption;
- on utterance end (800 ms of silence) one final request returns the authoritative text.

It deliberately does **not** POST mic audio as a streaming (duplex) request body.
Reason, measured: for a `ReadableStream` upload Chrome resolves the
`fetch()` promise only when the body ends (headers arrive at 11 ms, `fetch()` resolved at
2398 ms = utterance end), so no SSE delta can ever be read while the mic is still uploading.
The `/live` ASR route therefore produces no live captions in a browser, even though it works
from curl (where the body is sent all at once).

## Known limits / next

- if the pi bridge isn't running, `/bridge/*` is 502 and the app falls back to a kokoro
  readback of the transcript, so the loop is still testable end to end.
- Barge-in uses an energy VAD (`-30 dBFS`, 3 frames ≈ 130 ms) to stop playback when you
  start talking. Server-side turn detection would be tighter; silero/marblenet VAD is
  available in audio.cpp if that proves too coarse.
- Partial captions re-decode the audio so far, so text can visibly revise mid-sentence;
  the final transcript comes from a separate clean pass on the completed utterance.
- `qwen3-asr` (31 languages) and `voxtral-asr` (4B, 13 languages) are installed as ASR
  alternatives — swap `ASR_MODEL` in index.html to compare. voxtral needs the S2S
  model's VRAM freed first.
- `createScriptProcessor` is gone (it also had a bad buffer size and monitored the mic);
  capture now uses an AudioWorklet with a gain-0 sink so the mic is never played back.
