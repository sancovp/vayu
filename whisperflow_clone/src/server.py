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
        load_whisper_model()
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
    
    BYTES_PER_SEC = 16000 * 2          # 16kHz mono int16
    SILENT_FINALIZE_SEC = 0.8           # pause closes the segment immediately
    MAX_SEGMENT_SEC = 15.0              # force-close before the window can slide
    MIN_VOICED_SEC = 0.25               # never transcribe a buffer with less real
                                        # speech than this — whisper tiny.en
                                        # hallucinates ("Thank you.") on silence

    logger.info("Transcription worker started.")
    try:
        while True:
            # Poll every 250ms
            await asyncio.sleep(0.25)

            chunks = audio_buffer.get_chunks()
            if not chunks:
                continue

            # Silence gate: skip inference entirely until the buffer holds
            # enough voiced audio (kills silence hallucinations + saves compute)
            voiced_sec = sum(
                len(c) / BYTES_PER_SEC for c in chunks
                if not audio_buffer.is_silent(c)
            )
            if voiced_sec < MIN_VOICED_SEC:
                continue

            # Run transcription asynchronously in thread pool, biased toward the
            # user's vocabulary (Vayu maintains whisper_bias.txt; read cheaply,
            # cached by mtime). This is what steers tiny.en toward "vayu" etc.
            result = await transcribe_audio_chunks_async(model, chunks, initial_prompt=read_bias())
            text = result.get("text", "").strip()
            
            if not text:
                continue
                
            # Check for silence or segment end heuristics
            # Let's count silence chunks at the end of our current buffer
            # to see if the speaker paused.
            trailing_silence_sec = 0.0
            # Check the last 15 chunks (about ~0.5 seconds of audio)
            chunk_sec = 1024 / 16000  # 64ms per chunk
            for chunk in reversed(chunks[-15:]):
                if audio_buffer.is_silent(chunk):
                    trailing_silence_sec += chunk_sec
                else:
                    break
            
            is_partial = True
            if text == prev_text:
                stable_count += 1
            else:
                stable_count = 0
                prev_text = text
                
            buffered_sec = len(chunks) * chunk_sec
            
            should_close = text and (
                stable_count >= max_stable_cycles
                or trailing_silence_sec >= SILENT_FINALIZE_SEC
                or buffered_sec >= MAX_SEGMENT_SEC
            )
            
            if should_close:
                is_partial = False
                audio_buffer.clear()
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
