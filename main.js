require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen, globalShortcut, session } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { switchTo }              = require('./windows');
const { readEnv, writeEnv }     = require('./env-utils');
const { transcribeAudio, resetClient: resetSttClient } = require('./stt');
const { resetClient: resetIntentClient }              = require('./intent');
const { execute }               = require('./executor');

let mainWindow;
let settingsWindow = null;
let stopCurrentBot = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 220,
    height: 110,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    transparent: true,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'widget', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'widget', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    const { workAreaSize } = screen.getPrimaryDisplay();
    mainWindow.setPosition(workAreaSize.width - 240, workAreaSize.height - 130);
    mainWindow.show();
  });
}

function sendStatus(event, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, data);
  }
}

function launchBot() {
  try {
    const { startBot } = require('./bot');
    stopCurrentBot = startBot(sendStatus);
  } catch (err) {
    console.error('Failed to start bot:', err);
    sendStatus('status', { state: 'error', text: err.message.slice(0, 30) });
  }
}

app.whenReady().then(() => {
  // Allow microphone access for the renderer (local voice recording)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media';
  });

  createWindow();
  launchBot();

  // Global voice hotkey — toggles mic recording in the widget
  const VOICE_HOTKEY = process.env.VOICE_HOTKEY || 'CommandOrControl+Shift+Space';
  try {
    globalShortcut.register(VOICE_HOTKEY, () => {
      mainWindow?.webContents.send('toggle-recording');
    });
  } catch (err) {
    console.warn('Could not register voice hotkey:', err.message);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => app.quit());

// ── Widget IPC ───────────────────────────────────────────────────────────────

ipcMain.on('close-app', () => app.quit());

ipcMain.on('switch-window', async (_, target) => {
  if (target === 'write') {
    sendStatus('status', { state: 'idle', text: 'write mode' });
    return;
  }
  sendStatus('status', { state: 'processing', text: `→ ${target}` });
  try {
    await switchTo(target);
    sendStatus('status', { state: 'idle' });
  } catch (err) {
    sendStatus('status', { state: 'error', text: err.message.slice(0, 32) });
    setTimeout(() => sendStatus('status', { state: 'idle' }), 4000);
  }
});

// Execute a command directly from the widget (future: command input box)
ipcMain.on('execute-command', async (_, text) => {
  sendStatus('status', { state: 'processing', text: text.slice(0, 32) });
  try {
    const result = await execute(text, { notify: sendStatus });
    sendStatus('status', { state: 'idle', text: result.slice(0, 32) });
    setTimeout(() => sendStatus('status', { state: 'idle', text: '' }), 3000);
  } catch (err) {
    sendStatus('status', { state: 'error', text: err.message.slice(0, 32) });
    setTimeout(() => sendStatus('status', { state: 'idle' }), 4000);
  }
});

// Local mic recording — renderer sends WebM audio buffer after recording stops
ipcMain.on('recording-audio', async (_, audioData) => {
  const tmpFile = path.join(os.tmpdir(), `walter_mic_${Date.now()}.webm`);
  try {
    fs.writeFileSync(tmpFile, Buffer.from(audioData));
    sendStatus('status', { state: 'processing', text: 'transcribing...' });
    const text   = await transcribeAudio(tmpFile);
    const result = await execute(text, { notify: sendStatus, submit: false });
    // AI responses: just show a short confirmation in the widget
    // (full answer goes to Telegram if the bot is running; otherwise it's displayed briefly)
    const preview = result && typeof result === 'object'
      ? (result.photo ? 'image ready' : (result.text || '').slice(0, 32))
      : String(result || '').slice(0, 32);
    sendStatus('status', { state: 'idle', text: preview });
    setTimeout(() => sendStatus('status', { state: 'idle', text: '' }), 3000);
  } catch (err) {
    sendStatus('status', { state: 'error', text: err.message.slice(0, 32) });
    setTimeout(() => sendStatus('status', { state: 'idle' }), 4000);
  } finally {
    fs.unlink(tmpFile, () => {});
  }
});

// ── Settings IPC ─────────────────────────────────────────────────────────────

ipcMain.on('open-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 320,
    height: 445,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    transparent: true,
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'widget', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'widget', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
});

ipcMain.on('settings-close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

ipcMain.handle('settings-get', () => {
  const env = readEnv();
  return {
    token:       env.TELEGRAM_BOT_TOKEN || '',
    userId:      env.ALLOWED_USER_ID    || '',
    groqKey:     env.GROQ_API_KEY       || '',
    intentKey:   env.INTENT_API_KEY     || '',
    intentModel: env.INTENT_MODEL       || '',
  };
});

ipcMain.handle('settings-save', async (_, { token, userId, groqKey, intentKey, intentModel }) => {
  writeEnv({
    TELEGRAM_BOT_TOKEN: token,
    ALLOWED_USER_ID:    userId,
    GROQ_API_KEY:       groqKey     || '',
    INTENT_API_KEY:     intentKey   || '',
    INTENT_MODEL:       intentModel || '',
  });
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.ALLOWED_USER_ID    = userId;
  if (groqKey)     { process.env.GROQ_API_KEY    = groqKey;    resetSttClient(); }
  if (intentKey)   { process.env.INTENT_API_KEY  = intentKey; }
  if (intentModel) { process.env.INTENT_MODEL    = intentModel; }
  resetIntentClient();

  if (typeof stopCurrentBot === 'function') {
    try { stopCurrentBot(); } catch {}
  }

  sendStatus('status', { state: 'processing', text: 'restarting bot…' });
  await new Promise(r => setTimeout(r, 800));
  launchBot();
});
