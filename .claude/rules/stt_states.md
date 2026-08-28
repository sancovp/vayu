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
| flush-on-stop handshake | BUILT 2026-08-27 | **the "it doesn't pick up sound" bug.** All three segment-close rules (2 stable passes / 0.8s trailing silence / 15s cap) are free-running and none can fire when the user stops talking and releases the hotkey together; `stopAndPaste` closed the WS at once, the worker was cancelled mid-utterance and the audio discarded untranscribed. `{"cmd":"flush"}` now force-closes the segment and always acks `flushed:true`; `stopAndPaste` stops the mic → awaits flush → closes. Measured: 1.2s utterance 0 msgs → `'Open the dashboard.'`; 4.8s sentence 0 finals → full transcript incl. the trailing clause the old path always lost |
| mic pre-warm + hot stream | BUILT 2026-08-27 | first `getUserMedia` after launch took 3.6s while the user was already talking — speech lost before the stream existed. Stream now acquired at window load and kept alive for the app's lifetime (device label logged; per-recording avg/peak RMS logged, explicit MIC DELIVERED SILENCE marker). Confirmed working: two real dictations pasted ("Testing", "Trying it again.") |
| quit-gate while processing | BUILT 2026-08-27 | Isaac's "don't force close mid-processing": all quit paths funnel through `app.quit()`, one `before-quit` gate defers quit while the renderer's stop-cycle (flush→corrections→clipboard→paste) is flagged busy, 10s ceiling |
| cold-model keep-warm + real-speech warmup | BUILT 2026-08-28 | **the "first open fails, second works" root cause, caught by the instrumentation:** after hours idle (and even 30s after a fresh start), the first REAL inference took >3-9s — flush parsed, voiced audio in buffer, worker stuck inside transcribe until the client's 5s timeout lost the utterance; the stranded inference then re-warmed everything, which is why attempt 2 always worked and probes-minutes-later never reproduced it. Silence warm-up provably insufficient (all-zeros decodes trivially). Now: 3s recorded speech `warmup.pcm` + bias prompt at startup AND on a 4-min keep-warm beat (skipped while a session streams; slow beat logged as WAS COLD); silero pre-loaded at startup. Verified: fresh-start probes return finals where the identical probe failed |
| flush-empty-but-partial-saved | WATCH | one real dictation's flush transcribed the full buffer to '' while a mid-stream partial had already captured the text — paste worked via the partial fallback. Instrumentation (server logs control frames verbatim + per-session totals) stays in to attribute any recurrence |
| 50KB log cap (all 3 writers) | BUILT 2026-08-27 | `vayu_runtime.log` had reached 84MB, ~all of it one line per SPACEBAR PRESS from helper debug stdout. Keystroke chatter is now never persisted, identical consecutive lines collapse, and any log crossing 50KB is trimmed to its newest half. 88MB reclaimed |
| mlx large-v3-turbo backend | BUILT | default when mlx importable; weights cache ~/.cache/huggingface |
| silero VAD | BUILT | replaced `max(abs)<500` (the both-ways sensitivity bug) |
| 4x chunk-timing fix | BUILT | old code assumed 64ms chunks vs real 256ms |
| stt-venv at `<DATA_DIR>/stt-venv` | BUILT | where main.js health-check/spawn expects it |
| stale scratch server killed | see session | `~/.gemini/antigravity/scratch/whisperflow_clone` ran the LIVE STT until 2026-07-16 (0.0.0.0, no bias, tiny.en) — never serve from it again |
| packaged `/Applications/Vayu.app` | RE-PACKED 2026-08-07 | was frozen at the **Jul-5** build, which predates `startWhisperServer` (added Jul-16, `c00a255`) and bundled **no** `whisperflow_clone` at all — so the app never started :8181 and every dictation died as `Transcriber WS error: [object Event]` (connection refused). Re-packed from `cd17d67` via `npm run package-mac`, signed "Vayu Local Code Signing"; bundle now carries `main.js` with `startWhisperServer` + the vendored `whisperflow_clone/src`, so the app owns its own STT lifecycle |
