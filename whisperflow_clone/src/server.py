import os
import logging
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
from starlette.websockets import WebSocketDisconnect

from whisperflow_clone.src.transcriber import load_whisper_model, transcribe_audio_chunks_async
from whisperflow_clone.src.buffer import AudioBuffer
from whisperflow_clone.src.bias import read_bias

# Setup simple logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whisperflow_clone.server")

# Preload model on startup
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing server: preloading Whisper model...")
    try:
        model = load_whisper_model()
        # Warm through the SAME executor path the worker uses — the first
        # inference in the pool thread pays a multi-second one-time cost that
        # must not land on the user's first utterance.
        await transcribe_audio_chunks_async(model, [b"\x00" * 32000])
        logger.info("Model warmed through executor path.")
    except Exception as e:
        logger.error(f"Failed to preload model: {e}")
    yield
    logger.info("Server shutting down.")

app = FastAPI(lifespan=lifespan)

@app.get("/", response_class=HTMLResponse)
async def get_index():
    index_path = os.path.join(os.path.dirname(__file__), "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse(content="<h1>Index file not found</h1>", status_code=404)

@app.get("/health")
async def health():
    return {"status": "healthy", "service": "whisperflow_clone"}

async def transcription_worker(websocket: WebSocket, model, audio_buffer: AudioBuffer):
    prev_text = ""
    stable_count = 0
    max_stable_cycles = 2
    
    SILENT_FINALIZE_SEC = 0.8           # pause closes the segment immediately
    MAX_SEGMENT_SEC = 15.0              # force-close before the window can slide
    MIN_VOICED_SEC = 0.25               # never transcribe a buffer with less real
                                        # speech than this — whisper hallucinates
                                        # ("Thank you.") on silence

    logger.info("Transcription worker started.")
    try:
        while True:
            # Poll every 250ms
            await asyncio.sleep(0.25)

            # SNAPSHOT the buffer: audio keeps streaming in while inference
            # runs, and everything below (heuristics + segment close) must be
            # about what this pass actually transcribed, not the live buffer.
            chunks = list(audio_buffer.get_chunks())
            n_snapshot = len(chunks)
            if not chunks:
                continue

            # VAD gate: skip inference entirely until the buffer holds enough
            # real speech (kills silence hallucinations + saves compute).
            # Verdicts are silero-based and cached per chunk in the buffer.
            if audio_buffer.voiced_seconds() < MIN_VOICED_SEC:
                continue

            # Run transcription asynchronously in thread pool, biased toward the
            # user's vocabulary (Vayu maintains whisper_bias.txt; read cheaply,
            # cached by mtime). This is what steers decoding toward "vayu" etc.
            result = await transcribe_audio_chunks_async(model, chunks, initial_prompt=read_bias())
            text = result.get("text", "").strip()

            if not text:
                continue

            # Segment-end heuristics over the SNAPSHOT (real durations derived
            # from byte lengths — the old code hardcoded 64ms/chunk while the
            # overlay sends 256ms chunks, so every threshold ran 4x off).
            trailing_silence_sec = audio_buffer.trailing_silence_seconds(upto=n_snapshot)

            is_partial = True
            if text == prev_text:
                stable_count += 1
            else:
                stable_count = 0
                prev_text = text

            buffered_sec = AudioBuffer.seconds_of(chunks)

            should_close = text and (
                stable_count >= max_stable_cycles
                or trailing_silence_sec >= SILENT_FINALIZE_SEC
                or buffered_sec >= MAX_SEGMENT_SEC
            )

            if should_close:
                is_partial = False
                # Drop ONLY what this segment consumed; clear() would eat
                # audio that arrived during inference (start of next utterance).
                audio_buffer.drop_first(n_snapshot)
                prev_text = ""
                stable_count = 0
                logger.info(f"Segment closed: '{text}'")
                
            await websocket.send_json({
                "is_partial": is_partial,
                "text": text
            })
            
    except asyncio.CancelledError:
        logger.info("Transcription worker cancelled.")
    except Exception as e:
        logger.error(f"Error in transcription worker: {e}", exc_info=True)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("WebSocket connection accepted.")
    
    model = load_whisper_model()
    audio_buffer = AudioBuffer()
    
    # Start background transcription worker
    worker_task = asyncio.create_task(transcription_worker(websocket, model, audio_buffer))
    
    try:
        while True:
            data = await websocket.receive_bytes()
            if data:
                audio_buffer.add_chunk(data)
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"Error in WebSocket session: {e}", exc_info=True)
    finally:
        worker_task.cancel()
        try:
            await worker_task
        except Exception:
            pass
        audio_buffer.clear()
