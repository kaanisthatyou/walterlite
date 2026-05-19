const path   = require('path');
const os     = require('os');
const { runPS }              = require('./ps-utils');
const { pressKey, sendHotkey } = require('./keyboard');
const memory                 = require('./memory');

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

// --- App-open helpers ---

async function startProcess(exePath) {
  const b64 = Buffer.from(exePath, 'utf8').toString('base64');
  return runPS(`Start-Process ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`);
}

// Start Menu: searches both user and global .lnk / .exe entries
async function findInStartMenu(lower) {
  const b64 = Buffer.from(lower, 'utf8').toString('base64');
  const script = `
$q    = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$dirs = @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
          "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")
foreach ($d in $dirs) {
  $f = Get-ChildItem $d -Recurse -Include '*.lnk','*.exe' -ErrorAction SilentlyContinue |
       Where-Object { $_.BaseName -like "*$q*" } | Select-Object -First 1 -ExpandProperty FullName
  if ($f) { Write-Output $f; exit }
}`.trimStart();
  const out = await runPS(script).catch(() => '');
  return out?.trim() || null;
}

// Desktop: searches user Desktop for .lnk / .exe
async function findOnDesktop(lower) {
  const b64 = Buffer.from(lower, 'utf8').toString('base64');
  const script = `
$q       = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$desktop = [Environment]::GetFolderPath('Desktop')
$f = Get-ChildItem "$desktop\\*" -Include '*.lnk','*.exe' -ErrorAction SilentlyContinue |
     Where-Object { $_.BaseName -like "*$q*" } | Select-Object -First 1 -ExpandProperty FullName
if ($f) { Write-Output $f }`.trimStart();
  const out = await runPS(script).catch(() => '');
  return out?.trim() || null;
}

// Program Files: searches both PF dirs for name*.exe up to depth 2
async function findInProgramFiles(lower) {
  const b64 = Buffer.from(lower, 'utf8').toString('base64');
  const script = `
$q    = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$pf86 = [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$dirs = @($env:ProgramFiles, $pf86) | Where-Object { $_ }
foreach ($d in $dirs) {
  $f = Get-ChildItem $d -Filter "$q*.exe" -Recurse -Depth 2 -ErrorAction SilentlyContinue |
       Select-Object -First 1 -ExpandProperty FullName
  if ($f) { Write-Output $f; exit }
}`.trimStart();
  const out = await runPS(script).catch(() => '');
  return out?.trim() || null;
}

// LOCALAPPDATA: searches for name*.exe up to depth 3
async function findInLocalAppData(lower) {
  const b64 = Buffer.from(lower, 'utf8').toString('base64');
  const script = `
$q = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$f = Get-ChildItem $env:LOCALAPPDATA -Filter "$q*.exe" -Recurse -Depth 3 -ErrorAction SilentlyContinue |
     Select-Object -First 1 -ExpandProperty FullName
if ($f) { Write-Output $f }`.trimStart();
  const out = await runPS(script).catch(() => '');
  return out?.trim() || null;
}

async function openApp(appName) {
  const lower = appName.toLowerCase().trim();

  // Step 1: static map — instant for well-known apps
  if (APP_EXE[lower]) {
    try { await startProcess(APP_EXE[lower]); return `opened ${appName}`; } catch {}
  }

  // Step 2: memory — path discovered in a previous session
  const remembered = memory.get('apps', lower);
  if (remembered) {
    try { await startProcess(remembered); return `opened ${appName}`; } catch {}
    // stale path — fall through to search
  }

  // Step 3: Start Menu shortcuts
  const smPath = await findInStartMenu(lower);
  if (smPath) {
    await startProcess(smPath);
    memory.set('apps', lower, smPath);
    return `opened ${appName}`;
  }

  // Step 4: Desktop shortcuts
  const dtPath = await findOnDesktop(lower);
  if (dtPath) {
    await startProcess(dtPath);
    memory.set('apps', lower, dtPath);
    return `opened ${appName}`;
  }

  // Step 5: Program Files (depth 2)
  const pfPath = await findInProgramFiles(lower);
  if (pfPath) {
    await startProcess(pfPath);
    memory.set('apps', lower, pfPath);
    return `opened ${appName}`;
  }

  // Step 6: LOCALAPPDATA (depth 3)
  const laPath = await findInLocalAppData(lower);
  if (laPath) {
    await startProcess(laPath);
    memory.set('apps', lower, laPath);
    return `opened ${appName}`;
  }

  // Step 7: nothing found
  throw new Error(`"${appName}" bulunamadı — tam yolu Telegram'dan gönderir misin?`);
}

async function listWindows() {
  const script = `
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } |
  Sort-Object MainWindowTitle |
  ForEach-Object { "$($_.Name): $($_.MainWindowTitle)" }`.trimStart();
  return runPS(script);
}

// Modifies every Firefox shortcut (Desktop + Start Menu) to always launch with
// --remote-debugging-port=9222, enabling Playwright CDP access on every start.
// Safe to call multiple times — skips shortcuts that already have the flag.
async function setupFirefoxCDP() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  "$env:USERPROFILE\\Desktop\\Firefox.lnk",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Firefox.lnk",
  "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Firefox.lnk"
)
$shell = New-Object -ComObject WScript.Shell
$changed = @(); $already = @(); $missing = @()
foreach ($p in $paths) {
  if (-not (Test-Path $p)) { $missing += $p; continue }
  $sc = $shell.CreateShortcut($p)
  if ($sc.Arguments -like '*remote-debugging-port*') { $already += $p; continue }
  $sc.Arguments = ($sc.Arguments + ' --remote-debugging-port=9222').Trim()
  $sc.Save()
  $changed += $p
}
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
if ($changed) { "✅ Güncellendi: " + ($changed -join ', ') }
if ($already) { "ℹ️ Zaten ayarlı: " + ($already -join ', ') }
if (-not $changed -and -not $already) { "⚠️ Firefox kısayolu bulunamadı — Firefox'u masaüstüne pin'le sonra tekrar dene." }
`.trimStart();
  const result = await runPS(script);
  return (result?.trim() || 'Kısayol bulunamadı') +
    '\n\nFirefox\'u kapatıp kısayoldan yeniden aç. Artık her seferinde CDP açık başlayacak.';
}

module.exports = {
  captureScreen,
  takeScreenshot, setVolume, lockScreen,
  minimizeWindow, maximizeWindow, closeWindow,
  openApp, listWindows, setupFirefoxCDP,
  playPause, mediaNext, mediaPrev,
};
