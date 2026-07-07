# Single Canonical Design: whisperflow_clone

This project is a custom, local-first speech-to-text dictation application that clones the core architectural concepts of WhisperFlow. It is built entirely from scratch inside the scratch workspace at [whisperflow_clone](file:///Users/isaacwr/.gemini/antigravity/scratch/whisperflow_clone).

## Core Architecture

Our custom clone relies on three core entities:
1.  **Audio Ingestion (Client)**: Captures microphone input at 16kHz Mono 16-bit PCM and streams the raw bytes over WebSockets to the server.
2.  **FastAPI Server**: Runs a WebSocket endpoint `/ws` which keeps an active `AudioBuffer` session for each client.
3.  **Model Inference Executor**: Normalizes the audio bytes to float32 and transcribes them asynchronously in a thread executor utilizing OpenAI's Whisper model (`tiny.en.pt`).

```mermaid
graph TD
    Mic["Microphone (PyAudio)"] -->|Raw PCM 16kHz| Client["Client (client.py)"]
    Client -->|WebSocket Binary Chunks| Server["Server (server.py)"]
    Server -->|Append Chunk| Buffer["AudioBuffer (buffer.py)"]
    Buffer -->|Accumulated Window| Transcribe["transcribe_audio_chunks_async()"]
    Transcribe -->|ThreadPoolExecutor| Whisper["OpenAI Whisper Engine"]
    Whisper -->|Raw Transcription Text| Heuristics["Stabilization Heuristics"]
    Heuristics -->|Stable Text (2 Cycles)| Reset["Flush AudioBuffer"]
    Heuristics -->|JSON Payload| Server
    Server -->|JSON Update (is_partial)| Client
    Client -->|Stdout (Carriage Return)| Terminal["Terminal Output"]
```

---

## File Manifest

*   [requirements.txt](file:///Users/isaacwr/.gemini/antigravity/scratch/whisperflow_clone/requirements.txt): Runtime dependencies.
*   [transcriber.py](file:///Users/isaacwr/.gemini/antigravity/scratch/whisperflow_clone/src/transcriber.py): Manages thread-safe model caching and float32 audio normalization.
*   [buffer.py](file:///Users/isaacwr/.gemini/antigravity/scratch/whisperflow_clone/src/buffer.py): Sliding audio buffer window tracking silence and stability windows.
*   [server.py](file:///Users/isaacwr/.gemini/antigravity/scratch/whisperflow_clone/src/server.py): FastAPI WebSockets server serving static frontend assets and isolating client sessions.
*   [index.html](file:///Users/isaacwr/.gemini/antigravity/scratch/whisperflow_clone/src/index.html): HTML5 browser client that records audio at 16kHz and pipes raw binary data to the websocket.
*   [client.py](file:///Users/isaacwr/.gemini/antigravity/scratch/whisperflow_clone/src/client.py): Terminal audio capture input from default microphone soundcard.
*   [run.sh](file:///Users/isaacwr/.gemini/antigravity/scratch/whisperflow_clone/run.sh): Environment setup, dependency installer, and service starter scripts.

---

## Stabilization and Segment Cleaving

To keep real-time transcription responsive and avoid model hallucinations:
*   The server tracks the output of consecutive transcription passes.
*   If the text remains identical for 2 consecutive evaluations (`stable_count >= 2`), the segment is marked as **final** (`is_partial: false`).
*   The `AudioBuffer` is then flushed, clearing the tumbling window so the next spoken sentence is processed cleanly.
*   The client receives `is_partial: false` and prints a final newline, pushing the finalized text block down.
