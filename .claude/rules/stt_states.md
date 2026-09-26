# Vayu STT engine — state

## Architecture (local to `whisperflow_clone/`)
| component | what | seam |
|---|---|---|
| `src/server.py` | FastAPI ws `/ws` :8181, 250ms-poll worker, segment cleaving (2 stable passes / 0.8s trailing silence / 15s cap) | overlay `index.html` connects; durations from byte lengths (overlay sends 256ms chunks) |
| `src/transcriber.py` | backend seam: **mlx** `large-v3-turbo` default (Metal) / **openai** `tiny.en` fallback; temp ladder + `condition_on_previous_text=False` + segment hallucination gate | `VAYU_STT_BACKEND`, `VAYU_WHISPER_MODEL` |
| `src/buffer.py` | per-chunk cached **silero-vad** verdicts; amplitude fallback (300) | `VAYU_VAD=amplitude` forces fallback |
| `src/bias.py` | vocabulary bias from `<VAYU_DATA_DIR>/whisper_bias.txt` → `initial_prompt` | Vayu `writeWhisperBias` writes it |

## State (2026-08-27)
| item | status | note |
|---|---|---|
| flush-on-stop handshake | BUILT 2026-08-27 | stop → flush → close: the segment is forced closed and always acked, so the last words are transcribed → `vayu_scratchpad.md` |
| mic pre-warm + hot stream | BUILT 2026-08-27 | the mic stream is opened at window load and kept for the app's life → `vayu_scratchpad.md` |
| quit-gate while processing | BUILT 2026-08-27 | Isaac's "don't force close mid-processing": all quit paths funnel through `app.quit()`, one `before-quit` gate defers quit while the renderer's stop-cycle (flush→corrections→clipboard→paste) is flagged busy, 10s ceiling |
| cold-model keep-warm + real-speech warmup | BUILT 2026-08-28 | a 3 s recorded-speech warm-up at start + a 4-min keep-warm beat; the root cause → `vayu_scratchpad.md` |
| flush-empty-but-partial-saved | WATCH | one real dictation's flush transcribed the full buffer to '' while a mid-stream partial had already captured the text — paste worked via the partial fallback. Instrumentation (server logs control frames verbatim + per-session totals) stays in to attribute any recurrence |
| 50KB log cap (all 3 writers) | BUILT 2026-08-27 | `vayu_runtime.log` had reached 84MB, ~all of it one line per SPACEBAR PRESS from helper debug stdout. Keystroke chatter is now never persisted, identical consecutive lines collapse, and any log crossing 50KB is trimmed to its newest half. 88MB reclaimed |
| mlx large-v3-turbo backend | BUILT | default when mlx importable; weights cache ~/.cache/huggingface |
| silero VAD | BUILT | replaced `max(abs)<500` (the both-ways sensitivity bug) |
| 4x chunk-timing fix | BUILT | old code assumed 64ms chunks vs real 256ms |
| stt-venv at `<DATA_DIR>/stt-venv` | BUILT | where main.js health-check/spawn expects it |
| stale scratch server killed | see session | `~/.gemini/antigravity/scratch/whisperflow_clone` ran the LIVE STT until 2026-07-16 (0.0.0.0, no bias, tiny.en) — never serve from it again |
| packaged `/Applications/Vayu.app` | RE-PACKED 2026-08-07 | re-packed from `cd17d67` with `startWhisperServer` and the vendored `whisperflow_clone/src`; the app owns its STT → `vayu_scratchpad.md` |

## VOICE COMMANDS

The lane `DESIGN.md` §I states. Phases: **DESIGNED** (§I states it) → **BUILT** (the code does it) → **VERIFIED**
(proven live, or by a test). `●` = reached.

| deliverable | DESIGNED | BUILT | VERIFIED | detail |
|---|:-:|:-:|:-:|---|
| command routes — create · tell · replace · pipe, in Vayu's command system | ● |  |  | `DESIGN.md` §I |
| the pending draft + progressive approval; the Approval / Auto setting | ● |  |  | `DESIGN.md` §I |
| Jev boundaries — the utterance's quote and new text · the passage in a file | ● |  |  | `DESIGN.md` §I |
| NetworkEditTool replace of the located span | ● |  |  | `DESIGN.md` §I |
| OM Explorer as context and landing (its state file · the result opens in it) | ● |  |  | `DESIGN.md` §I · OM `DESIGN.md` §37 |
