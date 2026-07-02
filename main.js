const { app, BrowserWindow, ipcMain, screen, systemPreferences, globalShortcut, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow = null;
let dashboardWindow = null;
let permissionWindow = null;
let daemonProcess = null;
let lastShortcutAt = 0;
let lastGlobalShortcutActivationAt = 0;
let accessibilityDialogOpen = false;

const DATA_DIR = process.env.VAYU_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Vayu');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Create a log stream for the helper in the workspace folder
const logStream = fs.createWriteStream(path.join(DATA_DIR, 'vayu_daemon.log'), { flags: 'w' });

function appendRuntimeLog(message) {
  fs.appendFileSync(path.join(DATA_DIR, 'vayu_runtime.log'), `${new Date().toISOString()} ${message}\n`);
}

// Error logging
process.on('uncaughtException', (err) => {
  fs.writeFileSync(path.join(DATA_DIR, 'vayu_error.log'), `Uncaught Exception: ${err.message}\nStack: ${err.stack}\n`);
  appendRuntimeLog(`main uncaughtException ${err.message}`);
  app.quit();
});

process.on('unhandledRejection', (reason) => {
  const detail = reason && reason.stack ? reason.stack : String(reason);
  fs.writeFileSync(path.join(DATA_DIR, 'vayu_error.log'), `Unhandled Rejection: ${detail}\n`);
  appendRuntimeLog(`main unhandledRejection ${detail}`);
});

function startDaemon() {
  appendRuntimeLog('startDaemon called');
  // Clear any existing orphaned helper binaries
  try {
    const { execSync } = require('child_process');
    execSync('pkill -9 -f "/helper"');
  } catch (e) {}

  // In packaged app, macOS execution policies require binaries to reside in Contents/MacOS
  const helperPath = app.isPackaged
    ? path.join(__dirname, '..', '..', 'MacOS', 'helper')
    : path.join(__dirname, 'helper');

  logStream.write(`Vayu: Attempting to spawn native helper at ${helperPath}...\n`);

  try {
    daemonProcess = spawn(helperPath);
    appendRuntimeLog(`spawned helper pid=${daemonProcess.pid}`);

    daemonProcess.on('error', (err) => {
      logStream.write(`Vayu: Failed to spawn native helper: ${err.message}\n`);
      appendRuntimeLog(`helper spawn error ${err.message}`);
    });

    daemonProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        const cmd = line.trim();
        if (cmd === "keydown" || cmd === "keyup") {
          logStream.write(`Vayu Event: Forwarding ${cmd} to renderer\n`);
          appendRuntimeLog(`helper event ${cmd}`);
          sendShortcutEvent(cmd, 'nativeHelper');
        } else if (cmd.length > 0) {
          logStream.write(`Vayu Helper: ${cmd}\n`);
          appendRuntimeLog(`helper stdout ${cmd}`);
        }
      });
    });

    daemonProcess.stderr.on('data', (data) => {
      logStream.write(`Vayu Helper Error: ${data.toString()}`);
      appendRuntimeLog(`helper stderr ${data.toString().trim()}`);
    });

    daemonProcess.on('close', (code) => {
      logStream.write(`Vayu Helper exited with code ${code}\n`);
      appendRuntimeLog(`helper close code=${code}`);
    });

  } catch (e) {
    logStream.write(`Vayu Exception spawning helper: ${e.message}\n`);
  }
}

function createWindow() {
  appendRuntimeLog('createWindow called');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: 400,
    height: 180,
    x: Math.floor((width - 400) / 2),
    y: height - 200, // Position near the bottom above the Dock
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false, // Start hidden, shown via IPC/event
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    appendRuntimeLog(`renderer console level=${level} ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    appendRuntimeLog(`overlay did-fail-load code=${errorCode} description=${errorDescription} url=${validatedURL}`);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    appendRuntimeLog(`overlay render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });

  mainWindow.webContents.on('unresponsive', () => {
    appendRuntimeLog('overlay unresponsive');
  });

  // Ensure overlay floats on top of full-screen spaces
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  
  // Make the overlay window click-through
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // Handle visibility IPC from renderer
  ipcMain.on('show-window', () => {
    appendRuntimeLog('ipc show-window');
    if (mainWindow) {
      mainWindow.showInactive(); // Show without stealing keyboard/active app focus
    }
  });

  ipcMain.on('hide-window', () => {
    appendRuntimeLog('ipc hide-window');
    if (mainWindow) {
      mainWindow.hide();
    }
  });

  ipcMain.on('set-ignore-mouse', (event, ignore, options) => {
    appendRuntimeLog(`ipc set-ignore-mouse ignore=${ignore}`);
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(ignore, options);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createDashboardWindow() {
  appendRuntimeLog('createDashboardWindow called');
  if (dashboardWindow) {
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 950,
    height: 650,
    title: "Vayu Dashboard",
    backgroundColor: "#080a10",
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  dashboardWindow.loadFile(path.join(__dirname, 'dashboard.html'));

  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
}

function createPermissionWindow() {
  appendRuntimeLog('createPermissionWindow called');
  if (permissionWindow) {
    permissionWindow.focus();
    return;
  }

  permissionWindow = new BrowserWindow({
    width: 560,
    height: 390,
    title: 'Vayu Permissions',
    backgroundColor: '#10131a',
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { margin: 0; padding: 28px; background: #10131a; color: #f4f7fb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1 { font-size: 22px; margin: 0 0 12px; }
p { color: #b8c0cc; line-height: 1.45; font-size: 14px; }
.path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #1c2330; border: 1px solid #30394a; border-radius: 6px; padding: 10px; color: #d8e7ff; }
.actions { display: grid; gap: 10px; margin-top: 18px; }
button { height: 34px; border: 1px solid #3a4659; border-radius: 7px; background: #202939; color: #f4f7fb; font-size: 13px; cursor: pointer; }
button.primary { background: #2f6feb; border-color: #3b82f6; }
</style>
</head>
<body>
<h1>Grant Vayu Accessibility</h1>
<p>Vayu can copy transcripts, but macOS will not allow automatic paste until this exact app is enabled in Accessibility.</p>
<p>If Vayu is not listed, use the plus button in Accessibility and add:</p>
<div class="path">/Applications/Vayu.app</div>
<div class="actions">
  <button class="primary" id="open">Open Accessibility Settings</button>
  <button id="reveal">Reveal Vayu.app in Finder</button>
  <button id="prompt">Request macOS Prompt Once</button>
  <button id="restart">Restart Vayu</button>
  <button id="quit">Quit Vayu</button>
</div>
<script>
const { ipcRenderer } = require('electron');
document.getElementById('open').onclick = () => ipcRenderer.invoke('open-accessibility-settings');
document.getElementById('reveal').onclick = () => ipcRenderer.invoke('reveal-vayu-app');
document.getElementById('prompt').onclick = () => ipcRenderer.invoke('request-accessibility-prompt');
document.getElementById('restart').onclick = () => ipcRenderer.invoke('restart-vayu');
document.getElementById('quit').onclick = () => ipcRenderer.invoke('quit-vayu');
</script>
</body>
</html>`;

  permissionWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  permissionWindow.on('closed', () => {
    permissionWindow = null;
  });
}

function restartVayu(reason) {
  appendRuntimeLog(`restart requested${reason ? ` reason=${reason}` : ''}`);
  app.relaunch();
  app.quit();
}

function createApplicationMenu() {
  const template = [
    {
      label: 'Vayu',
      submenu: [
        {
          label: 'Open Dashboard',
          accelerator: 'CommandOrControl+D',
          click: () => createDashboardWindow()
        },
        {
          label: 'Accessibility Help',
          click: () => createPermissionWindow()
        },
        {
          label: 'Restart Vayu',
          accelerator: 'CommandOrControl+Shift+R',
          click: () => restartVayu('menu')
        },
        { type: 'separator' },
        {
          label: 'Quit Vayu',
          accelerator: 'CommandOrControl+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  appendRuntimeLog('application menu installed');
}

function sendShortcutEvent(cmd, source) {
  const now = Date.now();
  if (now - lastShortcutAt < 180) {
    appendRuntimeLog(`shortcut ignored duplicate cmd=${cmd} source=${source}`);
    return;
  }

  lastShortcutAt = now;
  appendRuntimeLog(`shortcut dispatch cmd=${cmd} source=${source}`);

  if (mainWindow) {
    mainWindow.webContents.send('global-shortcut-event', cmd);
  } else {
    appendRuntimeLog(`shortcut dropped cmd=${cmd} source=${source}; mainWindow is null`);
  }
}

function registerShortcutFallback() {
  appendRuntimeLog('registerShortcutFallback called');

  const accelerator = 'Control+Space';
  const registered = globalShortcut.register(accelerator, () => {
    const now = Date.now();
    if (now - lastGlobalShortcutActivationAt < 1200) {
      lastGlobalShortcutActivationAt = now;
      appendRuntimeLog(`globalShortcut repeat ignored ${accelerator}`);
      return;
    }

    lastGlobalShortcutActivationAt = now;
    appendRuntimeLog(`globalShortcut activated ${accelerator}`);
    sendShortcutEvent('toggle', 'globalShortcut');
  });

  appendRuntimeLog(`globalShortcut ${registered ? 'registered' : 'failed'} ${accelerator}`);

  const quitRegistered = globalShortcut.register('CommandOrControl+Shift+Q', () => {
    appendRuntimeLog('globalShortcut quit CommandOrControl+Shift+Q');
    app.quit();
  });

  appendRuntimeLog(`globalShortcut ${quitRegistered ? 'registered' : 'failed'} CommandOrControl+Shift+Q`);
}

function checkAccessibilityTrust(prompt) {
  if (process.platform !== 'darwin' || typeof systemPreferences.isTrustedAccessibilityClient !== 'function') {
    return true;
  }

  const trusted = systemPreferences.isTrustedAccessibilityClient(prompt);
  appendRuntimeLog(`accessibility trusted=${trusted} prompt=${prompt}`);
  return trusted;
}

// Handle request to open the dashboard window
ipcMain.on('open-dashboard', () => {
  createDashboardWindow();
});

ipcMain.handle('check-accessibility-trust', (event, prompt) => {
  return checkAccessibilityTrust(Boolean(prompt));
});

ipcMain.handle('show-accessibility-help', async () => {
  if (accessibilityDialogOpen) {
    return;
  }

  accessibilityDialogOpen = true;
  appendRuntimeLog('show accessibility help dialog');

  try {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'Vayu Needs Accessibility',
      message: 'Vayu copied the transcript, but macOS is blocking automatic paste.',
      detail: 'Open System Settings -> Privacy & Security -> Accessibility, remove any old Vayu entries, add /Applications/Vayu.app, enable it, then restart Vayu.',
      buttons: ['Open Settings', 'Restart Vayu', 'Quit Vayu', 'OK'],
      defaultId: 0,
      cancelId: 3
    });

    if (result.response === 0) {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      createPermissionWindow();
    } else if (result.response === 1) {
      restartVayu('accessibility dialog');
    } else if (result.response === 2) {
      appendRuntimeLog('quit requested from accessibility dialog');
      app.quit();
    }
  } finally {
    accessibilityDialogOpen = false;
  }
});

ipcMain.handle('open-accessibility-settings', async () => {
  appendRuntimeLog('open accessibility settings');
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

ipcMain.handle('reveal-vayu-app', async () => {
  appendRuntimeLog('reveal Vayu.app in Finder');
  shell.showItemInFolder('/Applications/Vayu.app');
});

ipcMain.handle('request-accessibility-prompt', () => {
  appendRuntimeLog('request accessibility prompt once');
  return checkAccessibilityTrust(true);
});

ipcMain.handle('restart-vayu', () => {
  restartVayu('permission window');
});

ipcMain.handle('quit-vayu', () => {
  appendRuntimeLog('quit requested from permission window');
  app.quit();
});

// Prevent multiple instances of the application
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // If a second instance is launched, focus the dashboard
  app.on('second-instance', () => {
    createDashboardWindow();
  });

  app.whenReady().then(() => {
    createApplicationMenu();
    const accessibilityTrusted = checkAccessibilityTrust(false);
    startDaemon(); // Spawn the background helper binary
    createWindow();
    if (!accessibilityTrusted) {
      createPermissionWindow();
    }
    appendRuntimeLog('dashboard auto-open skipped');
    registerShortcutFallback();
    
    // Explicitly prompt for microphone access on macOS startup
    if (process.platform === 'darwin' && typeof systemPreferences.askForMediaAccess === 'function') {
      systemPreferences.askForMediaAccess('microphone').then(granted => {
        console.log('Microphone access granted:', granted);
      }).catch(err => {
        console.error('Microphone media request failed:', err);
      });
    }
  });
}

app.on('will-quit', () => {
  appendRuntimeLog('app will-quit');
  globalShortcut.unregisterAll();
  if (daemonProcess) {
    daemonProcess.kill();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
