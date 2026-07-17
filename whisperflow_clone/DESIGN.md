# Single Canonical Design: whisperflow_clone (Vayu's bundled STT engine)

Local-first speech-to-text dictation engine, vendored INSIDE Vayu at
`~/claude_code/vayu/whisperflow_clone/` (the canonical copy — the original
scratch copy at `~/.gemini/antigravity/scratch/whisperflow_clone` is legacy and
must never be edited or served from again; it ran the live STT until
2026-07-16, missing the bias seam and pinned to tiny.en, which is what made
Vayu "worse than WhisperFlow").

## Core Architecture

1.  **Audio Ingestion (Client)**: the Vayu Electron overlay captures mic input
    at 16kHz mono 16-bit PCM (ScriptProcessor, 4096-sample = 256ms chunks) and
    streams raw bytes over WebSocket to `ws://127.0.0.1:8181/ws`.
2.  **FastAPI Server** (`src/server.py`): `/ws` keeps an `AudioBuffer` per
    client; a 250ms-poll worker transcribes the growing buffer and emits
    `{is_partial, text}` JSON.
3.  **VAD gate** (`src/buffer.py`): **silero-vad** (neural speech detector)
    verdicts cached per chunk on arrival; amplitude fallback (threshold 300)
    if silero is unavailable (`VAYU_VAD=amplitude` forces it). This replaced a
    bare `max(abs) < 500` gate that was simultaneously too sensitive (clicks/
    noise counted as voice → hallucinations) and not sensitive enough (soft
    speech eaten). All durations derive from real byte lengths — the old code
    hardcoded 64ms/chunk against the overlay's actual 256ms chunks, so every
    timing heuristic ran 4x off.
4.  **Transcription backend seam** (`src/transcriber.py`):
    - **mlx** (default when importable — Apple Silicon Metal):
      `mlx-community/whisper-large-v3-turbo`. WhisperFlow-parity accuracy,
      real-time on M-series.
    - **openai** (fallback): openai-whisper CPU, `models/tiny.en.pt`.
    - Env: `VAYU_STT_BACKEND=mlx|openai`, `VAYU_WHISPER_MODEL=<name/repo>`.
    - Decode: temperature fallback ladder (0.0→0.2→0.4),
      `condition_on_previous_text=False` (partial re-decodes must not
      self-feed), segment-level hallucination gate
      (`no_speech_prob>0.6 && avg_logprob<-1.0` → dropped).
5.  **Vocabulary bias** (`src/bias.py`): Vayu maintains
    `<VAYU_DATA_DIR>/whisper_bias.txt`; fed as `initial_prompt` so decoding
    leans toward "vayu"-class out-of-vocab names. Cached by mtime.

## Lifecycle

Vayu's `main.js` owns the server: health-check `:8181`; if absent, bootstrap
`<VAYU_DATA_DIR>/stt-venv` from `requirements.txt` and spawn
`uvicorn whisperflow_clone.src.server:app --host 127.0.0.1 --port 8181`.
Serve on **127.0.0.1 only** — the legacy scratch instance listened on 0.0.0.0.
mlx model weights cache in `~/.cache/huggingface`.

## Stabilization and Segment Cleaving

*   Identical text for 2 consecutive passes (`stable_count >= 2`) OR trailing
    silence ≥ 0.8s OR buffered audio ≥ 15s → segment **final**
    (`is_partial: false`), buffer flushed.
*   The VAD gate skips inference entirely until ≥ 0.25s of real speech is
    buffered (kills silence hallucinations + saves compute).
