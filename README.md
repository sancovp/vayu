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

The package script builds the native helper, creates an Apple Silicon app bundle, installs it to `/Applications/Vayu.app`, copies the helper into `Contents/MacOS`, signs the helper as `com.vayu.dictation.helper`, signs the app as `com.vayu.dictation`, and verifies the installed bundle.

By default packaging reuses a local identity named `Vayu Local Code Signing` when it exists. If that identity is not installed, packaging falls back to safe ad-hoc signing with stable identifiers. Set `VAYU_CODESIGN_IDENTITY` to use a Developer ID or another existing code-signing identity.

After migrating from an older build, remove the old Vayu entry from **System Settings -> Privacy & Security -> Accessibility**, add `/Applications/Vayu.app` again, and enable it once. Future restarts should keep the toggle on when the installed app is not rebuilt or re-signed with a different identity.

## Runtime Data

By default Vayu writes logs and transcript backups to:

```text
~/Library/Application Support/Vayu
```

Set `VAYU_DATA_DIR` to override this location during development.
