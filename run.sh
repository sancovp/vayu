#!/bin/bash
# Vayu Launch Script

# Navigate to the script's directory
cd "$(dirname "$0")"

# Start the background hotkey daemon using our virtual env python
echo "Launching Vayu global hotkey listener daemon..."
../../.venv/bin/python daemon.py &
DAEMON_PID=$!

# Register cleanup handler to terminate the daemon on exit
cleanup() {
    echo "Terminating Vayu hotkey listener daemon (PID: $DAEMON_PID)..."
    kill $DAEMON_PID 2>/dev/null
}
trap cleanup EXIT

# Launch the Electron overlay
echo "Launching transparent WebGL Vayu wave overlay..."
npm start
