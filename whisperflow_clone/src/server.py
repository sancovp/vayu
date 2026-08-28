import os
import json
import logging
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
from starlette.websockets import WebSocketDisconnect

from whisperflow_clone.src.transcriber import load_whisper_model, transcribe_audio_chunks_async
from whisperflow_clone.src.buffer import AudioBuffer, BYTES_PER_SEC
from whisperflow_clone.src.bias import read_bias

# Setup simple logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whisperflow_clone.server")

# Sessions currently streaming — the keep-warm beat skips while one is live.
_active_sessions = 0

KEEPWARM_INTERVAL_SEC = 240   # 4 min — well inside the idle horizon that went cold


async def _keepwarm_loop(model):
    """Run a tiny inference on a cadence so the model NEVER goes cold.

    After hours idle, the first real inference took >9s (measured 2026-08-28
    04:40: flush parsed, 3.58s of voiced audio in the buffer, worker silent for
    the whole 10s window — stuck inside its first transcribe). Cold cost =
    paged-out weights + evicted Metal state + App Nap throttling the idle
    process. A half-second dummy transcription every few minutes keeps all
    three hot, and the steady activity keeps App Nap off the process. Cost:
    well under a second of GPU every 4 minutes.
    """
    beats = 0
    while True:
        await asyncio.sleep(KEEPWARM_INTERVAL_SEC)
        if _active_sessions > 0:
            continue  # a real session is already keeping everything hot
        try:
            t0 = asyncio.get_event_loop().time()
            await transcribe_audio_chunks_async(model, [b"\x00" * 16000])
            took = asyncio.get_event_loop().time() - t0
            beats += 1
            # One line an hour is enough to prove liveness; a slow beat is the
            # cold-start smoking gun and always worth a line.
            if took > 2.0 or beats % 15 == 0:
                logger.info(f"keep-warm beat #{beats}: {took:.2f}s{' — WAS COLD' if took > 2.0 else ''}")
        except Exception as e:
            logger.error(f"keep-warm beat failed: {e}")


# Preload model on startup
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing server: preloading Whisper model...")
    keepwarm_task = None
    try:
        model = load_whisper_model()
        # Warm through the SAME executor path the worker uses — the first
        # inference in the pool thread pays a multi-second one-time cost that
        # must not land on the user's first utterance.
        await transcribe_audio_chunks_async(model, [b"\x00" * 32000])
        logger.info("Model warmed through executor path.")
        keepwarm_task = asyncio.create_task(_keepwarm_loop(model))
    except Exception as e:
        logger.error(f"Failed to preload model: {e}")
    yield
    if keepwarm_task:
        keepwarm_task.cancel()
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

async def transcription_worker(websocket: WebSocket, model, audio_buffer: AudioBuffer,
                               flush_event: asyncio.Event):
    prev_text = ""
    stable_count = 0
    max_stable_cycles = 2

    SILENT_FINALIZE_SEC = 0.8           # pause closes the segment immediately
    MAX_SEGMENT_SEC = 15.0              # force-close before the window can slide
    MIN_VOICED_SEC = 0.25               # never transcribe a buffer with less real
                                        # speech than this — whisper hallucinates
                                        # ("Thank you.") on silence
    FLUSH_MIN_VOICED_SEC = 0.10         # on an explicit flush the user DID speak,
                                        # so accept a shorter tail than the
                                        # free-running gate would

    logger.info("Transcription worker started.")
    try:
        while True:
            # Poll every 250ms — but wake IMMEDIATELY when the client asks to
            # flush, so releasing the hotkey doesn't cost an extra poll.
            flushing = False
            try:
                await asyncio.wait_for(flush_event.wait(), timeout=0.25)
                flushing = True
            except asyncio.TimeoutError:
                pass

            # SNAPSHOT the buffer: audio keeps streaming in while inference
            # runs, and everything below (heuristics + segment close) must be
            # about what this pass actually transcribed, not the live buffer.
            chunks = list(audio_buffer.get_chunks())
            n_snapshot = len(chunks)

            if flushing:
                # THE STOP PATH. The client has stopped the mic and is waiting
                # to paste. Transcribe whatever is left RIGHT NOW and close the
                # segment unconditionally — the free-running heuristics (2 stable
                # passes / 0.8s trailing silence / 15s cap) can never fire here,
                # because the user stops talking and releases the key in the same
                # motion. Without this the worker is cancelled mid-utterance and
                # the whole segment is silently discarded.
                flush_event.clear()
                text = ""
                if chunks and audio_buffer.voiced_seconds() >= FLUSH_MIN_VOICED_SEC:
                    result = await transcribe_audio_chunks_async(
                        model, chunks, initial_prompt=read_bias())
                    text = result.get("text", "").strip()
                audio_buffer.drop_first(n_snapshot)
                prev_text = ""
                stable_count = 0
                logger.info(f"Flush closed segment: '{text}'")
                # ALWAYS ack, even with empty text — the client blocks on this
                # message, and a silent flush must not cost it the full timeout.
                await websocket.send_json(
                    {"is_partial": False, "text": text, "flushed": True})
                continue

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
    global _active_sessions
    await websocket.accept()
    _active_sessions += 1
    logger.info("WebSocket connection accepted.")
    
    model = load_whisper_model()
    audio_buffer = AudioBuffer()
    flush_event = asyncio.Event()

    # Start background transcription worker
    worker_task = asyncio.create_task(
        transcription_worker(websocket, model, audio_buffer, flush_event))

    n_audio_frames = 0
    n_audio_bytes = 0
    try:
        while True:
            # receive() rather than receive_bytes(): the socket carries BOTH the
            # PCM stream (binary) and control commands (text, e.g. {"cmd":"flush"}
            # sent when the user releases the hotkey).
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))

            data = message.get("bytes")
            if data:
                audio_buffer.add_chunk(data)
                n_audio_frames += 1
                n_audio_bytes += len(data)
                continue

            raw = message.get("text")
            if raw is not None:
                # Control frames are rare and small — log them verbatim so a
                # flush that never fires is visible as either "arrived but
                # unparsed" or "never arrived at all".
                logger.info(f"control frame: {raw[:200]!r}")
                try:
                    cmd = json.loads(raw).get("cmd")
                except Exception:
                    cmd = None
                if cmd == "flush":
                    flush_event.set()
    except WebSocketDisconnect:
        logger.info(
            f"WebSocket client disconnected. Session totals: "
            f"{n_audio_frames} audio frames, {n_audio_bytes} bytes "
            f"({n_audio_bytes / BYTES_PER_SEC:.2f}s), "
            f"voiced={audio_buffer.voiced_seconds():.2f}s")
    except Exception as e:
        logger.error(f"Error in WebSocket session: {e}", exc_info=True)
    finally:
        _active_sessions -= 1
        worker_task.cancel()
        try:
            await worker_task
        except Exception:
            pass
        audio_buffer.clear()
