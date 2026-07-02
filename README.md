# Vayu

Vayu is a local macOS dictation overlay built with Electron. It uses a global `Control+Space` shortcut, streams microphone audio to a local Whisperflow server, displays the live transcript while recording, saves local transcript backups, copies the final text to the clipboard, and can paste into the frontmost app when macOS Accessibility permission is granted.

## Requirements

- macOS
- Node.js and npm
- Local Whisperflow-compatible WebSocket server at `ws://localhost:8181/ws`
- Accessibility permission for `/Applications/Vayu.app` for automatic paste
- Microphone permission for dictation

## Development

```sh
npm install
npm start
```

## Package For macOS

```sh
npm run package-mac
```

The package script builds the native helper, creates an Apple Silicon app bundle, installs it to `/Applications/Vayu.app`, copies the helper into `Contents/MacOS`, and ad-hoc signs the bundle.

## Runtime Data

By default Vayu writes logs and transcript backups to:

```text
~/Library/Application Support/Vayu
```

Set `VAYU_DATA_DIR` to override this location during development.
