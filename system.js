const path = require('path');
const os   = require('os');
const { runPS } = require('./ps-utils');
const { pressKey, sendHotkey } = require('./keyboard');

const CS_WIN32 = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class SYS {
  [DllImport("user32.dll")] public static extern bool LockWorkStation();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public const int SW_MINIMIZE=6, SW_MAXIMIZE=3, SW_RESTORE=9;
  public const uint WM_CLOSE=0x10;
  public static void Lock()     { LockWorkStation(); }
  public static void Minimize() { ShowWindow(GetForegroundWindow(), SW_MINIMIZE); }
  public static void Maximize() { ShowWindow(GetForegroundWindow(), SW_MAXIMIZE); }
  public static void Close()    { PostMessage(GetForegroundWindow(), WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }
}
'@ -ErrorAction SilentlyContinue`;

// Common app name → executable mappings
const APP_EXE = {
  notepad:     'notepad.exe',
  calculator:  'calc.exe',
  calc:        'calc.exe',
  paint:       'mspaint.exe',
  wordpad:     'wordpad.exe',
  chrome:      'chrome.exe',
  firefox:     'firefox.exe',
  edge:        'msedge.exe',
  safari:      'safari.exe',
  explorer:    'explorer.exe',
  terminal:    'wt.exe',
  cmd:         'cmd.exe',
  powershell:  'powershell.exe',
  vscode:      'code.exe',
  code:        'code.exe',
  spotify:     'Spotify.exe',
  discord:     'Discord.exe',
  slack:       'slack.exe',
  teams:       'Teams.exe',
  zoom:        'Zoom.exe',
  vlc:         'vlc.exe',
  word:        'WINWORD.EXE',
  excel:       'EXCEL.EXE',
  powerpoint:  'POWERPNT.EXE',
  outlook:     'OUTLOOK.EXE',
  snipping:    'SnippingTool.exe',
};

async function captureScreen() {
  const out = path.join(os.tmpdir(), `walter_ss_${Date.now()}.png`);
  const ps  = out.replace(/'/g, "''");
  await runPS(`
    Add-Type -AssemblyName System.Drawing,System.Windows.Forms
    $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $b=New-Object System.Drawing.Bitmap($s.Width,$s.Height)
    $g=[System.Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen($s.X,$s.Y,0,0,$s.Size)
    $b.Save('${ps}')
    $g.Dispose();$b.Dispose()
  `);
  return out;
}

async function takeScreenshot() {
  return captureScreen();
}

async function setVolume(dir) {
  const keyMap = { up: 'volumeup', down: 'volumedown', mute: 'volumemute', playpause: 'mediaplaypause' };
  const key = keyMap[dir];
  if (!key) throw new Error(`Unknown volume direction: ${dir}`);
  return pressKey(key);
}

async function playPause() {
  return pressKey('mediaplaypause');
}

async function mediaNext() {
  return pressKey('medianext');
}

async function mediaPrev() {
  return pressKey('mediaprev');
}

async function lockScreen() {
  return runPS(`${CS_WIN32}\n[SYS]::Lock()`);
}

async function minimizeWindow() {
  return runPS(`${CS_WIN32}\n[SYS]::Minimize()`);
}

async function maximizeWindow() {
  return runPS(`${CS_WIN32}\n[SYS]::Maximize()`);
}

async function closeWindow() {
  return runPS(`${CS_WIN32}\n[SYS]::Close()`);
}

async function openApp(appName) {
  const lower = appName.toLowerCase().trim();
  const exe   = APP_EXE[lower] || appName;
  const exeB64 = Buffer.from(exe, 'utf8').toString('base64');
  const script = `
$exe = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${exeB64}'))
try { Start-Process $exe -ErrorAction Stop }
catch {
  try { Start-Process "$exe.exe" -ErrorAction Stop }
  catch { Write-Error "Cannot open: $exe" }
}`.trimStart();
  return runPS(script);
}

async function listWindows() {
  const script = `
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } |
  Sort-Object MainWindowTitle |
  ForEach-Object { "$($_.Name): $($_.MainWindowTitle)" }`.trimStart();
  return runPS(script);
}

module.exports = {
  captureScreen,
  takeScreenshot, setVolume, lockScreen,
  minimizeWindow, maximizeWindow, closeWindow,
  openApp, listWindows,
  playPause, mediaNext, mediaPrev,
};
