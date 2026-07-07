"""Vocabulary bias seam.

Vayu maintains a bias prompt (proper nouns / jargon + correction targets) at
`<VAYU_DATA_DIR>/whisper_bias.txt` and rewrites it whenever automations.yaml
reloads. The transcription server reads it here and feeds it to whisper as
`initial_prompt`, which leans decoding toward those words — the ROOT fix for
tiny.en mishearing out-of-vocab names ("vayu" -> "vite"). Stdlib only; cached
by mtime so it costs nothing per segment. Returns "" when no bias is set.
"""
import os

_cache = {"path": None, "mtime": 0, "prompt": ""}


def _bias_path() -> str:
    data_dir = os.environ.get("VAYU_DATA_DIR") or os.path.join(
        os.path.expanduser("~"), "Library", "Application Support", "Vayu"
    )
    return os.path.join(data_dir, "whisper_bias.txt")


def read_bias() -> str:
    """The current vocabulary-bias prompt, or '' if none. Cached by file mtime."""
    path = _bias_path()
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        _cache.update(path=path, mtime=0, prompt="")
        return ""
    if _cache["path"] == path and _cache["mtime"] == mtime:
        return _cache["prompt"]
    try:
        with open(path, "r", encoding="utf-8") as f:
            prompt = f.read().strip()
    except OSError:
        prompt = ""
    _cache.update(path=path, mtime=mtime, prompt=prompt)
    return prompt
