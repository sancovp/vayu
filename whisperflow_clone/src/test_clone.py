import numpy as np
from whisperflow_clone.src.transcriber import load_whisper_model, transcribe_audio_chunks
from whisperflow_clone.src.buffer import AudioBuffer

def test_pipeline():
    print("Testing pipeline...")
    # 1. Create a dummy sine wave chunk (16kHz PCM, mono, 16-bit)
    sample_rate = 16000
    duration = 1.0  # 1 second
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    # 440 Hz tone
    audio_int16 = (np.sin(2 * np.pi * 440 * t) * 32767).astype(np.int16)
    chunk = audio_int16.tobytes()
    
    # 2. Test AudioBuffer
    buffer = AudioBuffer()
    buffer.add_chunk(chunk)
    assert len(buffer.get_chunks()) == 1
    
    # 3. Test Silence Heuristic
    # Sine wave is NOT silent
    assert not buffer.is_silent(chunk, threshold=500)
    # Zero bytes chunk IS silent
    silent_chunk = np.zeros(100, dtype=np.int16).tobytes()
    assert buffer.is_silent(silent_chunk, threshold=500)
    
    # 4. Test Transcriber (load model and run inference)
    model = load_whisper_model()
    result = transcribe_audio_chunks(model, buffer.get_chunks())
    print(f"Transcription result: '{result.get('text')}'")
    print("Verification completed successfully!")

if __name__ == "__main__":
    test_pipeline()
