import numpy as np

class AudioBuffer:
    """Manages the sliding/tumbling window buffer of raw PCM audio chunks."""
    
    def __init__(self, max_chunks: int = 1000):
        self.chunks = []
        self.max_chunks = max_chunks
        
    def add_chunk(self, chunk: bytes):
        """Adds a chunk of binary audio to the window buffer."""
        self.chunks.append(chunk)
        if len(self.chunks) > self.max_chunks:
            # Keep only the most recent chunks
            self.chunks = self.chunks[-self.max_chunks:]
            
    def get_chunks(self) -> list:
        """Returns the list of chunks currently in the buffer."""
        return self.chunks
        
    def clear(self):
        """Clears the buffer to start a new segment."""
        self.chunks = []
        
    def is_silent(self, chunk: bytes, threshold: int = 500) -> bool:
        """Checks if a chunk of 16-bit PCM audio is below the silence threshold."""
        if not chunk:
            return True
        data = np.frombuffer(chunk, dtype=np.int16)
        if len(data) == 0:
            return True
        return np.max(np.abs(data)) < threshold
