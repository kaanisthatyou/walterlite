const { runPS } = require('./ps-utils');

const CS_WIN32 = `Add-Type -TypeDefinition @'
  using System;
  using System.Runtime.InteropServices;
  public class WalterWin32 {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  }
'@ -ErrorAction SilentlyContinue`;

function focusByProcessName(procName) {
  const nameB64 = Buffer.from(procName, 'utf8').toString('base64');
  const script = `
${CS_WIN32}
$name = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${nameB64}'))
$proc = Get-Process -Name $name -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
if (-not $proc) { Write-Error "No running window for process: $name"; exit 1 }
$h = $proc.MainWindowHandle
if ([WalterWin32]::IsIconic($h)) { [WalterWin32]::ShowWindow($h, 9) | Out-Null }
[WalterWin32]::SetForegroundWindow($h) | Out-Null`.trimStart();
  return runPS(script);
}

function focusByWindowTitle(titlePart) {
  const titleB64 = Buffer.from(titlePart, 'utf8').toString('base64');
  const script = `
${CS_WIN32}
$title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${titleB64}'))
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$title*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "No window found matching: $title"; exit 1 }
$h = $proc.MainWindowHandle
if ([WalterWin32]::IsIconic($h)) { [WalterWin32]::ShowWindow($h, 9) | Out-Null }
[WalterWin32]::SetForegroundWindow($h) | Out-Null`.trimStart();
  return runPS(script);
}

// Well-known process names by alias
const PROCESS_ALIASES = {
  chrome:      'chrome',
  firefox:     'firefox',
  edge:        'msedge',
  safari:      'safari',
  vscode:      'Code',
  code:        'Code',
  notepad:     'notepad',
  terminal:    'WindowsTerminal',
  cmd:         'cmd',
  powershell:  'powershell',
  calculator:  'Calculator',
  calc:        'Calculator',
  spotify:     'Spotify',
  discord:     'Discord',
  slack:       'slack',
  teams:       'Teams',
  zoom:        'Zoom',
  explorer:    'explorer',
  excel:       'EXCEL',
  word:        'WINWORD',
  powerpoint:  'POWERPNT',
  outlook:     'OUTLOOK',
};

// launch: when true (default), tries openApp as last resort if no window found.
// Pass { launch: false } when you need the app to already be running (e.g. close_app).
async function switchTo(target, { launch = true } = {}) {
  const t = target.toLowerCase().trim();

  // Built-in configured targets
  if (t === 'claude')   return focusByProcessName(process.env.CLAUDE_PROCESS   || 'Claude');
  if (t === 'obsidian') return focusByProcessName(process.env.OBSIDIAN_PROCESS || 'Obsidian');

  if (t === 'gemini') {
    const browser = process.env.FIREFOX_PROCESS || 'firefox';
    return runPS(`Start-Process '${browser}' 'https://gemini.google.com/app'`);
  }

  // Well-known aliases
  if (PROCESS_ALIASES[t]) return focusByProcessName(PROCESS_ALIASES[t]);

  // Step 1: process name match
  try { return await focusByProcessName(target); } catch {}

  // Step 2: window title match
  try { return await focusByWindowTitle(target); } catch {}

  // Step 3: app not running yet — try launching it (unless caller opted out)
  if (launch) {
    const { openApp } = require('./system');
    return openApp(target);
  }

  throw new Error(`"${target}" çalışmıyor`);
}

module.exports = { switchTo, focusByProcessName, focusByWindowTitle };
