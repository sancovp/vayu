import asyncio
import json
import websockets
from pynput import keyboard

# WebSocket clients
CLIENTS = set()
loop = None

# Track pressed keys globally
PRESSED_KEYS = set()
# Set target shortcut to Control + Space
TARGET_KEYS = {keyboard.Key.ctrl, keyboard.Key.space}
is_triggered = False

async def broadcast(message):
    if CLIENTS:
        payload = json.dumps(message)
        await asyncio.gather(*[client.send(payload) for client in CLIENTS])

async def register(websocket):
    CLIENTS.add(websocket)
    print("Overlay client connected.")
    try:
        await websocket.wait_closed()
    finally:
        CLIENTS.remove(websocket)
        print("Overlay client disconnected.")

def on_press(key):
    global is_triggered
    PRESSED_KEYS.add(key)
    
    # Map left/right variants to generic modifiers
    if key == keyboard.Key.ctrl_l or key == keyboard.Key.ctrl_r:
        PRESSED_KEYS.add(keyboard.Key.ctrl)
    if key == keyboard.Key.space:
        PRESSED_KEYS.add(keyboard.Key.space)
    
    # Trigger event on keydown when both Control and Space are held
    if TARGET_KEYS.issubset(PRESSED_KEYS) and not is_triggered:
        is_triggered = True
        print("Hotkey Trigger DOWN (Start dictation)")
        if loop:
            asyncio.run_coroutine_threadsafe(broadcast({"event": "keydown"}), loop)

def on_release(key):
    global is_triggered
    # Remove from set safely
    if key in PRESSED_KEYS:
        PRESSED_KEYS.remove(key)
        
    # Check modifier variants
    if key == keyboard.Key.ctrl_l or key == keyboard.Key.ctrl_r:
        PRESSED_KEYS.discard(keyboard.Key.ctrl)
    if key == keyboard.Key.space:
        PRESSED_KEYS.discard(keyboard.Key.space)

    # Trigger event on keyup when combination is released (either Ctrl or Space is lifted)
    if not (keyboard.Key.ctrl in PRESSED_KEYS or keyboard.Key.ctrl_l in PRESSED_KEYS or keyboard.Key.ctrl_r in PRESSED_KEYS) or \
       not (keyboard.Key.space in PRESSED_KEYS):
        if is_triggered:
            is_triggered = False
            print("Hotkey Trigger UP (Stop dictation)")
            if loop:
                asyncio.run_coroutine_threadsafe(broadcast({"event": "keyup"}), loop)

async def main():
    global loop
    loop = asyncio.get_running_loop()
    
    print("Starting global hotkey keyboard listener (Control + Space)...")
    listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.start()
    
    print("Starting WebSocket server on ws://localhost:8077...")
    async with websockets.serve(register, "localhost", 8077):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Keyboard listener stopped.")
