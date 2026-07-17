"""Transcription backend seam.

Two backends, selected by env (auto-detect prefers mlx on Apple Silicon):
  - "mlx"    : mlx-whisper (Metal-native; runs large-v3-turbo in real time on
               M-series — WhisperFlow-parity quality). Default model:
               mlx-community/whisper-large-v3-turbo.
  - "openai" : openai-whisper on CPU (the original path). Default model:
               tiny.en.pt from the local models/ dir.

Env:
  VAYU_STT_BACKEND   = "mlx" | "openai"   (default: mlx if importable)
  VAYU_WHISPER_MODEL = model name/repo override for the chosen backend
"""
import os
import threading
import asyncio
import functools
import numpy as np

_BACKEND = None          # resolved backend name
_model_cache = {}
_cache_lock = threading.Lock()
_transcribe_lock = threading.Lock()

OPENAI_DEFAULT_MODEL = "tiny.en.pt"
MLX_DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"

# Segment-level hallucination gate (standard whisper heuristic): a segment that
# the model itself thinks is probably not speech AND decoded with very low
# confidence is dropped instead of surfaced ("Thank you." on breath noise).
NO_SPEECH_THRESHOLD = 0.6
LOGPROB_THRESHOLD = -1.0


def _resolve_backend() -> str:
    global _BACKEND
    if _BACKEND:
        return _BACKEND
    forced = os.environ.get("VAYU_STT_BACKEND", "").strip().lower()
    if forced in ("mlx", "openai"):
        _BACKEND = forced
        return _BACKEND
    try:
        import mlx_whisper  # noqa: F401
        _BACKEND = "mlx"
    except Exception:
        _BACKEND = "openai"
    return _BACKEND


def _model_name() -> str:
    override = os.environ.get("VAYU_WHISPER_MODEL", "").strip()
    if override:
        return override
    return MLX_DEFAULT_MODEL if _resolve_backend() == "mlx" else OPENAI_DEFAULT_MODEL


def get_model_path(model_name: str) -> str:
    """openai backend only: path to the model file in the local models folder."""
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    model_path = os.path.join(base_dir, "models", model_name)
    if os.path.exists(model_path):
        return model_path
    return model_name  # whisper will download it by name


def load_whisper_model(model_name: str = None):
    """Warm the chosen backend and return a handle usable by transcribe calls.

    mlx backend: mlx_whisper caches weights internally per repo — the handle is
    just the repo string; warming runs a dummy transcribe so the HF download +
    Metal compile happen at startup, not on the first spoken word.
    """
    name = model_name or _model_name()
    backend = _resolve_backend()
    key = (backend, name)
    if key in _model_cache:
        return _model_cache[key]
    with _cache_lock:
        if key in _model_cache:
            return _model_cache[key]
        if backend == "mlx":
            import mlx_whisper
            print(f"Warming mlx-whisper model '{name}' (Metal)...")
            mlx_whisper.transcribe(
                np.zeros(16000, dtype=np.float32), path_or_hf_repo=name,
                language="en", fp16=True, verbose=None,
            )
            _model_cache[key] = name  # handle == repo string
        else:
            import torch
            import whisper
            path = get_model_path(name)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            print(f"Loading Whisper model from '{path}' on device '{device}'...")
            _model_cache[key] = whisper.load_model(path).to(device)
    return _model_cache[key]


def _gate_segments(result: dict) -> str:
    """Reassemble text from segments, dropping likely-hallucinated ones."""
    segments = result.get("segments")
    if not segments:
        return result.get("text", "")
    kept = []
    for seg in segments:
        if (seg.get("no_speech_prob", 0.0) > NO_SPEECH_THRESHOLD
                and seg.get("avg_logprob", 0.0) < LOGPROB_THRESHOLD):
            continue
        kept.append(seg.get("text", ""))
    return "".join(kept)


def transcribe_audio_chunks(model, chunks: list, language: str = "en",
                            initial_prompt: str = None) -> dict:
    """Converts int16 PCM chunks into float32 array, normalizes it, and transcribes it.

    `initial_prompt` biases decoding toward a vocabulary (proper nouns / jargon)
    — this is how Vayu steers decoding toward out-of-vocab names it would
    otherwise snap to the nearest English word.
    """
    if not chunks:
        return {"text": ""}

    raw_bytes = b"".join(chunks)
    audio_data = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0

    kwargs = dict(
        language=language,
        # 0.0 first for determinism/latency; fallback rungs let whisper retry a
        # segment it decoded badly instead of emitting garbage.
        temperature=(0.0, 0.2, 0.4),
        condition_on_previous_text=False,  # partial re-decodes must not self-feed
    )
    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt

    with _transcribe_lock:
        if _resolve_backend() == "mlx":
            import mlx_whisper
            result = mlx_whisper.transcribe(
                audio_data, path_or_hf_repo=model, fp16=True, verbose=None, **kwargs
            )
        else:
            result = model.transcribe(audio_data, fp16=False, **kwargs)

    result["text"] = _gate_segments(result)
    return result


async def transcribe_audio_chunks_async(model, chunks: list, language: str = "en",
                                        initial_prompt: str = None) -> dict:
    """Asynchronously runs transcription in a separate thread pool executor."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        functools.partial(transcribe_audio_chunks, model, chunks, language, initial_prompt),
    )
