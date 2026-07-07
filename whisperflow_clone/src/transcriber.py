import os
import threading
import asyncio
import functools
import numpy as np
import torch
import whisper
from whisper import Whisper

# Cache for loaded models
_model_cache = {}
_cache_lock = threading.Lock()

DEFAULT_MODEL_NAME = "tiny.en.pt"

def get_model_path(model_name: str = DEFAULT_MODEL_NAME) -> str:
    """Gets the path to the model file in the local models folder."""
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    model_path = os.path.join(base_dir, "models", model_name)
    if os.path.exists(model_path):
        return model_path
    # Return model name directly if not found locally, whisper will download it
    return model_name

def load_whisper_model(model_name: str = DEFAULT_MODEL_NAME) -> Whisper:
    """Loads and caches the Whisper model in a thread-safe manner."""
    global _model_cache
    if model_name not in _model_cache:
        path = get_model_path(model_name)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading Whisper model from '{path}' on device '{device}'...")
        with _cache_lock:
            if model_name not in _model_cache:
                _model_cache[model_name] = whisper.load_model(path).to(device)
    return _model_cache[model_name]

_transcribe_lock = threading.Lock()

def transcribe_audio_chunks(model: Whisper, chunks: list, language: str = "en",
                            initial_prompt: str = None) -> dict:
    """Converts int16 PCM chunks into float32 array, normalizes it, and transcribes it.

    `initial_prompt` biases decoding toward a vocabulary (proper nouns / jargon)
    — this is how Vayu steers tiny.en toward out-of-vocab names it would
    otherwise snap to the nearest English word.
    """
    if not chunks:
        return {"text": ""}

    # Merge bytes and convert to float32
    raw_bytes = b"".join(chunks)
    audio_data = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0

    kwargs = dict(
        fp16=False,
        language=language,
        temperature=0.0,  # Deterministic decoding for low latency
    )
    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt

    # Run the transcription under a lock to prevent concurrent thread interference
    with _transcribe_lock:
        result = model.transcribe(audio_data, **kwargs)
    return result

async def transcribe_audio_chunks_async(model: Whisper, chunks: list, language: str = "en",
                                        initial_prompt: str = None) -> dict:
    """Asynchronously runs transcription in a separate thread pool executor."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        functools.partial(transcribe_audio_chunks, model, chunks, language, initial_prompt),
    )
