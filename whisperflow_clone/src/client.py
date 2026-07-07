import sys
import asyncio
import pyaudio
import websockets
import json

SAMPLE_RATE = 16000
CHUNK_SIZE = 1024
CHANNELS = 1

async def capture_and_stream_audio(server_url: str):
    p = pyaudio.PyAudio()
    
    # Open default audio input device (microphone)
    stream = p.open(
        format=pyaudio.paInt16,
        channels=CHANNELS,
        rate=SAMPLE_RATE,
        input=True,
        frames_per_buffer=CHUNK_SIZE
    )
    
    print(f"Connecting to WhisperFlow server at {server_url}...")
    try:
        async with websockets.connect(server_url) as websocket:
            print("\nConnected! Start speaking now. (Press Ctrl+C to stop)\n")
            
            # Sub-task: Listen for responses from the WebSocket server
            async def receive_transcripts():
                try:
                    async for message in websocket:
                        payload = json.loads(message)
                        text = payload.get("text", "")
                        is_partial = payload.get("is_partial", True)
                        
                        if text:
                            if is_partial:
                                # Carriage return updates the current line
                                sys.stdout.write(f"\rPartial: {text}")
                                sys.stdout.flush()
                            else:
                                # Overwrite the partial output with the final output and print a newline
                                sys.stdout.write(f"\rFinal:   {text}\n")
                                sys.stdout.flush()
                except websockets.exceptions.ConnectionClosed:
                    print("\nConnection closed by server.")
                except Exception as e:
                    print(f"\nError receiving: {e}")
            
            # Start the receiver loop as a background task
            receiver_task = asyncio.create_task(receive_transcripts())
            
            # Sender loop: Read chunks from PyAudio and send them over the WebSocket
            loop = asyncio.get_running_loop()
            while True:
                # Read chunks from the microphone non-blockingly
                chunk = await loop.run_in_executor(None, stream.read, CHUNK_SIZE, False)
                await websocket.send(chunk)
                await asyncio.sleep(0.01)
                
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"\nConnection failed: {e}")
    finally:
        # Cleanup
        print("\nStopping audio stream...")
        stream.stop_stream()
        stream.close()
        p.terminate()

def main():
    server_url = "ws://localhost:8181/ws"
    if len(sys.argv) > 1:
        server_url = sys.argv[1]
        
    try:
        asyncio.run(capture_and_stream_audio(server_url))
    except KeyboardInterrupt:
        print("\nDictation stopped. Goodbye!")

if __name__ == "__main__":
    main()
