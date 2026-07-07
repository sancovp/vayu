#!/bin/bash

CWD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$1" == "-setup" ]; then
    echo "Setting up virtual environment in $CWD/.venv..."
    python3 -m venv "$CWD/.venv"
    source "$CWD/.venv/bin/activate"
    pip install --upgrade pip wheel
    pip install "setuptools<70"
    pip install -r "$CWD/requirements.txt"
    echo "Setup complete! Activate the environment with: source whisperflow_clone/.venv/bin/activate"
elif [ "$1" == "-server" ]; then
    echo "Starting WhisperFlow Clone Server..."
    source "$CWD/.venv/bin/activate"
    export PYTHONPATH="$CWD/.."
    uvicorn whisperflow_clone.src.server:app --host 0.0.0.0 --port 8181
elif [ "$1" == "-client" ]; then
    echo "Starting WhisperFlow Clone Client..."
    source "$CWD/.venv/bin/activate"
    export PYTHONPATH="$CWD/.."
    python3 "$CWD/src/client.py" ws://localhost:8181/ws
else
    echo "Usage: ./run.sh [flag]"
    echo "Flags:"
    echo "  -setup   Create virtual environment and install requirements"
    echo "  -server  Start the FastAPI uvicorn server"
    echo "  -client  Start the dictation client (reads microphone, streams to server)"
fi
