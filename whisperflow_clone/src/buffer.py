"""Audio buffer with a real VAD seam.

The old gate was `max(abs(chunk)) < 500` — a bare amplitude threshold. That is
BOTH failure modes at once: soft speech below the threshold gets eaten (not
sensitive enough), while keyboard clicks / fan / bumps above it count as voice
and get fed to whisper, which then hallucinates (too sensitive). The fix is
silero-vad (a tiny neural speech detector, <1ms per 32ms window on CPU): it
answers "is this SPEECH", not "is this LOUD".

Each chunk's verdict is computed ONCE on add (not re-scanned every poll), and
durations are derived from actual byte lengths — the old code hardcoded a
64ms-per-chunk assumption while the Electron overlay actually sends 256ms
chunks, so every timing heuristic downstream ran 4x off.

Falls back to an amplitude gate (threshold lowered to 300) if silero is
unavailable. Env: VAYU_VAD=silero|amplitude to force.
"""
import os
import numpy as np

SAMPLE_RATE = 16000
BYTES_PER_SEC = SAMPLE_RATE * 2  # 16kHz mono int16
_SILERO_WINDOW = 512             # silero v5 requires exactly 512 samples @16k
_AMPLITUDE_THRESHOLD = 300

_silero_model = None
_silero_failed = False


def _get_silero():
    global _silero_model, _silero_failed
    if _silero_model is not None or _silero_failed:
        return _silero_model
    if os.environ.get("VAYU_VAD", "").strip().lower() == "amplitude":
        _silero_failed = True
        return None
    try:
        from silero_vad import load_silero_vad
        _silero_model = load_silero_vad()
        print("VAD: silero loaded.")
    except Exception as e:
        print(f"VAD: silero unavailable ({e}); falling back to amplitude gate.")
        _silero_failed = True
    return _silero_model


def _is_voiced(chunk: bytes) -> bool:
    """One-shot speech verdict for a chunk of 16-bit PCM."""
    if not chunk:
        return False
    data = np.frombuffer(chunk, dtype=np.int16)
    if len(data) == 0:
        return False

    model = _get_silero()
    if model is None:
        return int(np.max(np.abs(data))) >= _AMPLITUDE_THRESHOLD

    import torch
    audio = torch.from_numpy(data.astype(np.float32) / 32768.0)
    # scan the chunk in silero-sized windows; any speech window => voiced
    for start in range(0, len(audio) - _SILERO_WINDOW + 1, _SILERO_WINDOW):
        window = audio[start:start + _SILERO_WINDOW]
        with torch.no_grad():
            prob = model(window, SAMPLE_RATE).item()
        if prob >= 0.5:
            return True
    return False


class AudioBuffer:
    """Tumbling window of raw PCM chunks with per-chunk cached VAD verdicts."""

    def __init__(self, max_chunks: int = 1000):
        self.chunks = []
        self.voiced = []   # parallel list of bool verdicts (computed on add)
        self.max_chunks = max_chunks

    def add_chunk(self, chunk: bytes):
        self.chunks.append(chunk)
        self.voiced.append(_is_voiced(chunk))
        if len(self.chunks) > self.max_chunks:
            self.chunks = self.chunks[-self.max_chunks:]
            self.voiced = self.voiced[-self.max_chunks:]

    def get_chunks(self) -> list:
        return self.chunks

    def clear(self):
        self.chunks = []
        self.voiced = []

    def drop_first(self, n: int):
        """Drop the first n chunks (the ones a closed segment consumed) while
        KEEPING audio that arrived during inference — clear() here would race
        with the stream and eat the start of the next utterance."""
        self.chunks = self.chunks[n:]
        self.voiced = self.voiced[n:]

    @staticmethod
    def seconds_of(chunks: list) -> float:
        return sum(len(c) for c in chunks) / BYTES_PER_SEC

    def total_seconds(self) -> float:
        return sum(len(c) for c in self.chunks) / BYTES_PER_SEC

    def voiced_seconds(self) -> float:
        return sum(
            len(c) for c, v in zip(self.chunks, self.voiced) if v
        ) / BYTES_PER_SEC

    def trailing_silence_seconds(self, upto: int = None) -> float:
        """Duration of the unbroken non-speech run at the end of the buffer
        (or of the first `upto` chunks — the snapshot a transcribe pass saw)."""
        chunks = self.chunks[:upto] if upto is not None else self.chunks
        voiced = self.voiced[:upto] if upto is not None else self.voiced
        sec = 0.0
        for c, v in zip(reversed(chunks), reversed(voiced)):
            if v:
                break
            sec += len(c) / BYTES_PER_SEC
        return sec

    # Back-compat: old callers used is_silent(chunk) directly.
    def is_silent(self, chunk: bytes, threshold: int = _AMPLITUDE_THRESHOLD) -> bool:
        return not _is_voiced(chunk)
