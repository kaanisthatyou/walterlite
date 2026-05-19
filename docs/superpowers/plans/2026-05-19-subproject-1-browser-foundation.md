# Sub-project 1: Browser Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zero hardcoding — WALTER auto-detects any installed browser, normalizes any URL format (bare IPs, missing protocols), and can click elements in native Windows apps via UI Automation.

**Architecture:** A new `browser-detector.js` scans Windows known install paths at runtime and returns the best available browser. `playwright-session.js` delegates all browser selection to it, removing all hardcoded Firefox references. `normalizeUrl()` in `tool_browser.js` ensures bare IPs and protocol-less strings are valid before Playwright sees them. A new `ui-automation.js` uses PowerShell's `System.Windows.Automation` to click native UI elements by label — no browser required.

**Tech Stack:** Node.js, playwright-core (chromium + firefox APIs), PowerShell (UI Automation, process detection), Windows filesystem (browser path scanning)

---

## File Map

| Action | File | What changes |
|---|---|---|
| Create | `browser-detector.js` | Scans known paths, returns ranked browser list, caches to memory |
| Create | `ui-automation.js` | PowerShell UI Automation — `uiClick(text)`, `uiRead(window)` |
| Modify | `tools/tool_browser.js` | Add `normalizeUrl()`, apply before URL validation, remove hardcoded Firefox fallback |
| Modify | `playwright-session.js` | Replace `findFirefoxExe()` + `findRealProfile()` with `browser-detector.js` |
| Modify | `tools/index.js` | Register `ui_click` and `ui_read` tools |
| Modify | `planner.js` | Add URL routing rule, add `ui_click`/`ui_read` to tool list, add examples |

---

## Task 1: URL Normalizer

**Files:**
- Modify: `tools/tool_browser.js` (lines 1–56)

This fixes the immediate reported bug: `10.16.40.250:8000 adresine git` → planner sends bare IP to `open_url` → `new URL()` throws → wrong tool used.

- [ ] **Step 1: Add `normalizeUrl` and `isLocalAddress` before `openUrl`**

Open `tools/tool_browser.js`. After line 5 (`const FIREFOX_PATH = ...`) add:

```javascript
// Ensures any URL string has a protocol so new URL() can parse it.
// Bare IP:port and localhost → http, everything else → https.
function normalizeUrl(raw) {
  const s = (raw || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(s) || /^localhost(:\d+)?(\/|$)/i.test(s)) {
    return `http://${s}`;
  }
  return `https://${s}`;
}

// Returns true for local IP/localhost URLs — these skip the bare-domain guard
// (user explicitly typed the address, it's not an extraction failure).
function isLocalAddress(url) {
  return /^https?:\/\/((\d{1,3}\.){3}\d{1,3}|localhost)(:\d+)?(\/|$)/i.test(url);
}
```

- [ ] **Step 2: Apply `normalizeUrl` inside `openUrl` and fix the validation block**

Replace the current `openUrl` validation block (lines 43–56):

```javascript
async function openUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('open_url: no URL provided — extraction likely failed');
  }
  const url = normalizeUrl(rawUrl.trim());

  // Bare-domain guard: skip for local IPs/ports (user typed it explicitly).
  // For public URLs, reject bare domains with no path — likely an extraction failure.
  if (!isLocalAddress(url)) {
    try {
      const u = new URL(url);
      if ((u.pathname === '' || u.pathname === '/') && !u.search && !u.hash) {
        throw new Error(`open_url: "${url}" is a bare domain with no path — video URL extraction failed`);
      }
    } catch (e) {
      if (e.message.startsWith('open_url:')) throw e;
      throw new Error(`open_url: malformed URL "${url}"`);
    }
  }
```

Then update every reference to `url.trim()` inside `openUrl` to just `url` (it's already normalized).

The Playwright call becomes:
```javascript
  try {
    const { ensureSession } = require('../playwright-session');
    const result = await ensureSession({ url });
    if (result && result.photo) return result;
  } catch {
    // fall through to Win32
  }
```

And the Win32 fallback paste:
```javascript
    await pasteText(url, { submit: true });
```

And the Start-Process fallback:
```javascript
    const escaped = url.replace(/'/g, "''");
    await runPS(`Start-Process "${FIREFOX_PATH}" -ArgumentList '${escaped}'`);
```

- [ ] **Step 3: Verify fix manually**

Start the app (`npm start`). Send via Telegram:
```
10.16.40.250:8000 adresine git
```
Expected: planner uses `open_url`, browser opens, screenshot comes back. No `start_session` in the plan.

Also test:
```
sahibinden.com'a git
```
Expected: navigates to `https://sahibinden.com`.

- [ ] **Step 4: Commit**

```bash
cd C:/Users/Kaan/Desktop/Coding/walterlite
git add tools/tool_browser.js
git commit -m "fix: normalize bare IP/port and protocol-less URLs in open_url"
```

---

## Task 2: Browser Detector

**Files:**
- Create: `browser-detector.js`

Scans known install paths in priority order: Chrome → Edge → Opera GX → Brave → Firefox. Returns the first found with its executable path, Playwright API type, and profile directory. Caches to memory so detection only runs once.

- [ ] **Step 1: Create `browser-detector.js`**

```javascript
const fs     = require('fs');
const path   = require('path');
const memory = require('./memory');

const LOCAL  = process.env.LOCALAPPDATA || '';
const APPDATA = process.env.APPDATA     || '';
const PF     = process.env.ProgramFiles || 'C:\\Program Files';
const PF86   = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

// Browsers in priority order. Chromium-based first — CDP is more stable than Firefox CDP.
const BROWSER_DEFS = [
  {
    name: 'chrome',
    api: 'chromium',
    exePaths: [
      path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(PF,   'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    profileBase: path.join(LOCAL, 'Google', 'Chrome', 'User Data'),
    profileSub:  'Default',
  },
  {
    name: 'edge',
    api: 'chromium',
    exePaths: [
      path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(PF,   'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(LOCAL, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    profileBase: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data'),
    profileSub:  'Default',
  },
  {
    name: 'opera_gx',
    api: 'chromium',
    exePaths: [
      path.join(LOCAL, 'Programs', 'Opera GX', 'launcher.exe'),
      path.join(LOCAL, 'Programs', 'Opera GX', 'opera.exe'),
    ],
    profileBase: path.join(APPDATA, 'Opera Software', 'Opera GX Stable'),
    profileSub:  '',
  },
  {
    name: 'brave',
    api: 'chromium',
    exePaths: [
      path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(PF,   'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ],
    profileBase: path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    profileSub:  'Default',
  },
  {
    name: 'firefox',
    api: 'firefox',
    exePaths: [
      path.join(PF,   'Mozilla Firefox', 'firefox.exe'),
      path.join(PF86, 'Mozilla Firefox', 'firefox.exe'),
    ],
    profileBase: path.join(APPDATA, 'Mozilla', 'Firefox', 'Profiles'),
    profileSub:  null, // requires special finder
  },
];

function findFirefoxProfile(profilesDir) {
  if (!fs.existsSync(profilesDir)) return null;
  const dirs = fs.readdirSync(profilesDir).filter(d => {
    try { return fs.statSync(path.join(profilesDir, d)).isDirectory(); } catch { return false; }
  });
  const name = dirs.find(d => d.endsWith('.default-release'))
    || dirs.find(d => d.endsWith('.default'))
    || dirs[0];
  return name ? path.join(profilesDir, name) : null;
}

function resolveProfile(def) {
  if (!fs.existsSync(def.profileBase)) return null;
  if (def.profileSub === null) return findFirefoxProfile(def.profileBase);
  return def.profileSub
    ? path.join(def.profileBase, def.profileSub)
    : def.profileBase;
}

// Returns ordered list of installed browsers. Cached to memory after first run.
function detect() {
  const cached = memory.get('system', '__browsers');
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  const found = [];
  for (const def of BROWSER_DEFS) {
    const exePath = def.exePaths.find(p => fs.existsSync(p));
    if (!exePath) continue;
    found.push({
      name:        def.name,
      api:         def.api,           // 'chromium' | 'firefox'
      exePath,
      profilePath: resolveProfile(def),
    });
  }

  if (found.length) memory.set('system', '__browsers', found);
  return found;
}

// Returns the best available browser (highest priority found).
function best() {
  const list = detect();
  if (!list.length) {
    throw new Error(
      'No supported browser found — install Chrome, Edge, Opera GX, Brave, or Firefox'
    );
  }
  return list[0];
}

// Clears the cached browser list (call if user installs a new browser).
function clearCache() {
  memory.set('system', '__browsers', null);
}

module.exports = { detect, best, clearCache };
```

- [ ] **Step 2: Verify detection in a quick Node script**

```bash
cd C:/Users/Kaan/Desktop/Coding/walterlite
node -e "const d = require('./browser-detector'); console.log(JSON.stringify(d.detect(), null, 2));"
```

Expected output: array with at least one browser entry showing `name`, `api`, `exePath`, `profilePath`.

- [ ] **Step 3: Commit**

```bash
git add browser-detector.js
git commit -m "feat: add browser-detector — auto-detects Chrome, Edge, Opera GX, Brave, Firefox"
```

---

## Task 3: Playwright Session Refactor

**Files:**
- Modify: `playwright-session.js`

Replace all hardcoded Firefox logic with `browser-detector.js`. Support both Chromium and Firefox Playwright APIs dynamically.

- [ ] **Step 1: Add browser-detector import and remove Firefox-only helpers**

At the top of `playwright-session.js`, add:
```javascript
const { chromium, firefox } = require('playwright-core');
const browserDetector        = require('./browser-detector');
```

Remove (delete entirely):
- `function findFirefoxExe()` (lines ~31–39)
- `function findRealProfile()` (lines ~41–51)

- [ ] **Step 2: Replace `isFirefoxRunning` with `isBrowserRunning`**

Replace:
```javascript
async function isFirefoxRunning() {
  const out = await runPS(
    '(Get-Process firefox -ErrorAction SilentlyContinue | Measure-Object).Count'
  ).catch(() => '0');
  return parseInt(out.trim(), 10) > 0;
}
```

With:
```javascript
async function isBrowserRunning() {
  let detected;
  try { detected = browserDetector.best(); } catch { return false; }
  // Derive process name from exe filename (e.g. chrome.exe → chrome)
  const processName = require('path').basename(detected.exePath, '.exe').toLowerCase();
  const out = await runPS(
    `(Get-Process ${processName} -ErrorAction SilentlyContinue | Measure-Object).Count`
  ).catch(() => '0');
  return parseInt(out.trim(), 10) > 0;
}
```

- [ ] **Step 3: Replace step 2 (CDP connect) in `acquireContext` to use detected browser API**

Find the CDP connect block in `acquireContext`:
```javascript
  // 2. Connect via CDP (Firefox running with --remote-debugging-port=9222)
  try {
    const browser = await firefox.connectOverCDP('http://localhost:9222', { timeout: 2000 });
```

Replace with:
```javascript
  // 2. Connect via CDP (browser running with --remote-debugging-port=9222)
  try {
    let detected;
    try { detected = browserDetector.best(); } catch { detected = null; }
    const pw = (detected?.api === 'firefox') ? firefox : chromium;
    const browser = await pw.connectOverCDP('http://localhost:9222', { timeout: 2000 });
```

- [ ] **Step 4: Replace step 3 (launch browser) in `acquireContext` to use detected browser**

Find the launch block that starts with:
```javascript
  if (await isFirefoxRunning()) {
```

Replace the entire block (from that `if` through the end of `acquireContext`) with:

```javascript
  if (await isBrowserRunning()) {
    const detected = browserDetector.best();
    throw new Error(
      `${detected.name} açık ama Playwright erişimi yok. Bir kez kapat — WALTER CDP ile yeniden açacak. ` +
      `Veya: "firefox cdp kur" komutuyla kısayolu kalıcı olarak yapılandır.`
    );
  }

  const detected = browserDetector.best();
  const pw = detected.api === 'firefox' ? firefox : chromium;

  if (detected.profilePath) {
    _ownedCtx = await pw.launchPersistentContext(detected.profilePath, {
      executablePath: detected.exePath,
      headless:       false,
      viewport:       null,
      args:           ['--remote-debugging-port=9222'],
    });
  } else {
    _ownedCtx = await pw.launchPersistentContext('', {
      executablePath: detected.exePath,
      headless:       false,
      viewport:       null,
      args:           ['--remote-debugging-port=9222'],
    });
  }

  _ownedCtx.on('close', () => {
    _ownedCtx     = null;
    sessionPage   = null;
    sessionActive = false;
  });
  return _ownedCtx;
```

- [ ] **Step 5: Remove the old `const { firefox } = require('playwright-core')` line**

The top of the file currently has:
```javascript
const { firefox } = require('playwright-core');
```

Replace it with (added in Step 1 already):
```javascript
const { chromium, firefox } = require('playwright-core');
```

(If Step 1 already did this, just verify the line exists and remove any duplicate.)

- [ ] **Step 6: Verify manually**

Start app (`npm start`). Clear the browser cache first:
```bash
node -e "require('./browser-detector').clearCache();"
```

Send via Telegram:
```
google.com'a git
```
Expected: browser-detector picks best available browser, Playwright launches/connects it, screenshot comes back with Google homepage.

Check console — should see which browser was selected (not hardcoded Firefox).

- [ ] **Step 7: Commit**

```bash
git add playwright-session.js
git commit -m "feat: replace hardcoded Firefox with browser-detector in playwright-session"
```

---

## Task 4: UI Automation — Native Windows Clicking

**Files:**
- Create: `ui-automation.js`

Lets WALTER click buttons, menu items, and controls in native Windows apps using the accessibility tree — no browser, no screenshot coordinates needed.

- [ ] **Step 1: Create `ui-automation.js`**

```javascript
const { runPS } = require('./ps-utils');

// Clicks any visible native Windows UI element by its visible label text.
// Uses System.Windows.Automation — works in dialogs, menus, file pickers, any Win32 app.
async function uiClick(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const script = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
$target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$root   = [System.Windows.Automation.AutomationElement]::RootElement
$cond   = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  $target,
  [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase
)
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $el) { throw "UI element not found: $target" }

# Try InvokePattern first (buttons, menu items)
try {
  $inv = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $inv.Invoke()
  Write-Output "Invoked: $($el.Current.Name)"
} catch {
  # Fall back to mouse click at element center
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class UIAC {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x02, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x04, 0, 0, 0, UIntPtr.Zero);
  }
}
'@ -ErrorAction SilentlyContinue
  $r = $el.Current.BoundingRectangle
  [UIAC]::Click([int]($r.X + $r.Width/2), [int]($r.Y + $r.Height/2))
  Write-Output "Clicked: $($el.Current.Name)"
}`.trimStart();
  return runPS(script);
}

// Lists all visible interactive elements in a window (or foreground if no title given).
// Call this before ui_click to see what element names are available.
async function uiRead(windowTitle) {
  const scope = windowTitle
    ? `
$titleCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(windowTitle, 'utf8').toString('base64')}')),
  [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase
)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $titleCond)
if (-not $win) { $win = $root }`
    : '$win = $root';

  const script = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
$root = [System.Windows.Automation.AutomationElement]::RootElement
${scope}
$els = $win.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)
$out = @()
foreach ($el in $els) {
  $name = $el.Current.Name
  $type = $el.Current.LocalizedControlType
  $rect = $el.Current.BoundingRectangle
  if ($name -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
    $out += "[$type] $name"
  }
}
($out | Select-Object -Unique | Select-Object -First 40) -join [Environment]::NewLine`.trimStart();
  return runPS(script);
}

module.exports = { uiClick, uiRead };
```

- [ ] **Step 2: Register tools in `tools/index.js`**

Add the import at the top of `tools/index.js`:
```javascript
const { uiClick, uiRead } = require('../ui-automation');
```

Add to `TOOL_REGISTRY`:
```javascript
ui_click: ({ text })   => uiClick(text),
ui_read:  ({ window }) => uiRead(window),
```

- [ ] **Step 3: Verify manually**

Open Notepad (`npm start` → send "notepad aç"). Then send:
```
ui_read komutu çalıştır
```
Or trigger it via a quick Node test:
```bash
node -e "require('./ui-automation').uiRead().then(console.log).catch(console.error)"
```
Expected: list of UI elements including File, Edit menus.

Then send via Telegram:
```
Tamam butonuna tıkla
```
(Open any dialog that has an OK/Tamam button first.)

- [ ] **Step 4: Commit**

```bash
git add ui-automation.js tools/index.js
git commit -m "feat: add ui-automation — native Windows clicking via accessibility tree"
```

---

## Task 5: Planner Updates

**Files:**
- Modify: `planner.js`

Fix the URL routing rule (no more `start_session` for navigation) and add `ui_click`/`ui_read` to the tool list with examples.

- [ ] **Step 1: Add `ui_click` and `ui_read` to the TOOLS section in `planner.js`**

In the `SYSTEM_PROMPT` string, find the TOOLS block and add after `dom_scan_prefix`:

```
  ui_click(text)          clicks any native Windows UI element (button, checkbox, menu item) by its visible label — works in any app, not just browsers
  ui_read(window)         lists all visible interactive elements in a native Windows window by title — call before ui_click to discover element names
```

- [ ] **Step 2: Add URL routing rule to RULES section**

After rule 18, add:

```
19. URL NAVIGATION: Any URL, IP address (e.g. "10.16.40.250:8000"), or hostname is ALWAYS handled by open_url. Never generate start_session for navigation — open_url normalizes bare IPs and missing protocols automatically.
20. NATIVE UI: For clicking in native Windows apps (file dialogs, message boxes, menus), use ui_click(text). session_step and dom_inspect are for browser tabs only. When unsure what elements exist, call ui_read first.
```

- [ ] **Step 3: Add two examples at the end of EXAMPLES section**

```javascript
`
User: "10.16.40.250:8000 adresine git" (bare IP navigation — no protocol needed)
{"intent":"open_local_server","execution_plan":[{"step":1,"tool":"open_url","parameters":{"url":"10.16.40.250:8000"},"reason":"open_url normalizes bare IP:port to http:// automatically"}]}

User: "Tamam butonuna tıkla" or "Click the OK button" (native Windows dialog)
{"intent":"click_native_button","execution_plan":[{"step":1,"tool":"ui_click","parameters":{"text":"Tamam"},"reason":"click native Windows element by label via UI Automation"}]}

User: "bu pencerede ne var" or "what buttons are here" (inspect native UI)
{"intent":"inspect_native_ui","execution_plan":[{"step":1,"tool":"ui_read","parameters":{"window":""},"reason":"list all visible interactive elements in the foreground window"}]}`
```

- [ ] **Step 4: Verify planner routes correctly**

Start app. Send:
```
10.16.40.250:8000 adresine git
```
Watch the Telegram plan message — it should show `1. open_url` not `1. start_session`.

Send:
```
Tamam butonuna tıkla
```
Plan should show `1. ui_click`.

- [ ] **Step 5: Commit**

```bash
git add planner.js
git commit -m "fix: add URL routing rule and ui_click/ui_read to planner"
```

---

## Task 6: Clean Up Win32 Fallback in tool_browser.js

**Files:**
- Modify: `tools/tool_browser.js`

The Win32 fallback (paste URL into address bar) still hardcodes Firefox. Update it to use the detected browser.

- [ ] **Step 1: Remove the hardcoded `FIREFOX_PATH` constant**

Delete line 6:
```javascript
const FIREFOX_PATH = process.env.FIREFOX_PATH || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
```

- [ ] **Step 2: Update the Win32 fallback block inside `openUrl`**

Find the block starting with:
```javascript
  // Win32 fallback: paste URL into Firefox address bar
  const count = await runPS(
    '(Get-Process firefox -ErrorAction SilentlyContinue | Measure-Object).Count'
  ).catch(() => '0');
```

Replace the entire Win32 fallback block with:

```javascript
  // Win32 fallback: use browser-detector to find and open/navigate the browser
  let detected;
  try { detected = require('../browser-detector').best(); } catch { detected = null; }
  const processName = detected
    ? require('path').basename(detected.exePath, '.exe').toLowerCase()
    : 'chrome';

  const count = await runPS(
    `(Get-Process ${processName} -ErrorAction SilentlyContinue | Measure-Object).Count`
  ).catch(() => '0');

  if (parseInt(count.trim(), 10) > 0) {
    await switchTo(processName);
    await new Promise(r => setTimeout(r, 500));
    await sendHotkey('ctrl+l');
    await new Promise(r => setTimeout(r, 400));
    await pasteText(url, { submit: true });
  } else if (detected) {
    const escaped = detected.exePath.replace(/'/g, "''");
    const urlB64  = Buffer.from(url, 'utf8').toString('base64');
    await runPS(
      `Start-Process '${escaped}' -ArgumentList ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${urlB64}')))`
    );
    await new Promise(r => setTimeout(r, 3000));
    await switchTo(processName).catch(() => {});
  } else {
    throw new Error('No browser found for Win32 fallback — install Chrome, Edge, or Firefox');
  }
  return `Opened ${url}`;
```

- [ ] **Step 3: Commit**

```bash
git add tools/tool_browser.js
git commit -m "fix: remove hardcoded Firefox from Win32 URL fallback, use browser-detector"
```

---

## Sub-project 1 Complete

At this point:
- Any URL format works: `10.16.40.250:8000`, `sahibinden.com`, `https://youtube.com/...`
- Any installed browser is used automatically: Chrome, Edge, Opera GX, Brave, or Firefox
- Native Windows UI elements are clickable via `ui_click(text)` tool
- Planner never generates `start_session` for URL navigation

**Next:** Sub-project 2 — Vision Layer (Gemini free vision API for screen understanding and self-correction).
