# Vayu STT engine — state

## Architecture (local to `whisperflow_clone/`)
| component | what | seam |
|---|---|---|
| `src/server.py` | FastAPI ws `/ws` :8181, 250ms-poll worker, segment cleaving (2 stable passes / 0.8s trailing silence / 15s cap) | overlay `index.html` connects; durations from byte lengths (overlay sends 256ms chunks) |
| `src/transcriber.py` | backend seam: **mlx** `large-v3-turbo` default (Metal) / **openai** `tiny.en` fallback; temp ladder + `condition_on_previous_text=False` + segment hallucination gate | `VAYU_STT_BACKEND`, `VAYU_WHISPER_MODEL` |
| `src/buffer.py` | per-chunk cached **silero-vad** verdicts; amplitude fallback (300) | `VAYU_VAD=amplitude` forces fallback |
| `src/bias.py` | vocabulary bias from `<VAYU_DATA_DIR>/whisper_bias.txt` → `initial_prompt` | Vayu `writeWhisperBias` writes it |

## State (2026-07-16)
| item | status | note |
|---|---|---|
| mlx large-v3-turbo backend | BUILT | default when mlx importable; weights cache ~/.cache/huggingface |
| silero VAD | BUILT | replaced `max(abs)<500` (the both-ways sensitivity bug) |
| 4x chunk-timing fix | BUILT | old code assumed 64ms chunks vs real 256ms |
| stt-venv at `<DATA_DIR>/stt-venv` | BUILT | where main.js health-check/spawn expects it |
| stale scratch server killed | see session | `~/.gemini/antigravity/scratch/whisperflow_clone` ran the LIVE STT until 2026-07-16 (0.0.0.0, no bias, tiny.en) — never serve from it again |
| packaged `/Applications/Vayu.app` | STALE | bundles the pre-fix whisperflow_clone; needs `npm run package-mac` re-pack. Until then: if the canonical server isn't already on :8181 at app launch, the app spawns its OLD bundled code into the NEW venv |
