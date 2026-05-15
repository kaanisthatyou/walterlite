// Gemini automation — hybrid Win32 + Playwright.
//
// Firefox NOT running:
//   → Playwright launches it with your real Firefox profile (stays logged in).
//   → Full DOM access: text + image extraction.
//
// Firefox IS running:
//   → Win32 switches to it, opens a new tab, navigates to Gemini, types prompt.
//   → Playwright connects via CDP (port 9222) for DOM extraction.
//   → If CDP isn't available, falls back to clipboard text extraction.
//
// To enable CDP on a running Firefox: restart Firefox with --remote-debugging-port=9222
// Or just close Firefox — WALTER/lite will relaunch it with CDP automatically.

const { firefox } = require('playwright-core');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { runPS }                = require('./ps-utils');
const { switchTo }             = require('./windows');
const { sendHotkey, pressKey } = require('./keyboard');
const { injectText }           = require('./inject');

const GEMINI_URL = 'https://gemini.google.com/app';
const CDP_PORT   = 9222;

// ── Firefox helpers ────────────────────────────────────────────────────────────

const FIREFOX_PATHS = [
  process.env.FIREFOX_PATH,
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
].filter(Boolean);

function findFirefox() {
  for (const p of FIREFOX_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('Firefox not found — install it or set FIREFOX_PATH in .env');
}

function findRealProfile() {
  const profilesDir = path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles');
  if (!fs.existsSync(profilesDir)) throw new Error('Firefox profiles directory not found');
  const dirs = fs.readdirSync(profilesDir).filter(d => {
    try { return fs.statSync(path.join(profilesDir, d)).isDirectory(); } catch { return false; }
  });
  const name = dirs.find(d => d.endsWith('.default-release'))
    || dirs.find(d => d.endsWith('.default'))
    || dirs[0];
  if (!name) throw new Error('No Firefox profile found');
  return path.join(profilesDir, name);
}

async function isFirefoxRunning() {
  const out = await runPS(
    '(Get-Process firefox -ErrorAction SilentlyContinue | Measure-Object).Count'
  ).catch(() => '0');
  return parseInt(out.trim(), 10) > 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Playwright context management ─────────────────────────────────────────────

let ctx = null; // persistent Playwright context (owned by us when we launched Firefox)

async function getOwnedContext() {
  if (ctx) {
    try { ctx.pages(); return ctx; } catch { ctx = null; }
  }
  if (await isFirefoxRunning()) return null; // Can't own a running Firefox

  const profile = findRealProfile();
  ctx = await firefox.launchPersistentContext(profile, {
    executablePath: findFirefox(),
    headless: false,
    viewport: null,
    // Launch Firefox with remote debugging so future reconnects work too
    args: ['--remote-debugging-port=' + CDP_PORT],
  });
  ctx.on('close', () => { ctx = null; });
  return ctx;
}

async function getCDPContext() {
  try {
    const browser = await firefox.connectOverCDP(`http://localhost:${CDP_PORT}`, { timeout: 2000 });
    return browser.contexts()[0] || await browser.newContext();
  } catch {
    return null;
  }
}

// ── Playwright automation ──────────────────────────────────────────────────────

async function getOrOpenGeminiPage(context) {
  const pages = context.pages();
  let page = pages.find(p => p.url().includes('gemini.google.com'));
  if (page) {
    await page.bringToFront();
  } else {
    page = pages.length > 0 ? pages[0] : await context.newPage();
  }
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded' });
  return page;
}

async function findInput(page) {
  const selectors = [
    'rich-textarea [contenteditable="true"]',
    '[contenteditable="true"][aria-label]',
    '.ql-editor[contenteditable="true"]',
    '[contenteditable="true"]',
    'textarea',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible({ timeout: 1000 })) return el;
    } catch {}
  }
  throw new Error('Gemini input not found — are you logged in to Gemini in Firefox?');
}

// Wait for Gemini to finish generating — works for both text and image responses.
// Primary signal: stop button appears then disappears.
// Fallback: content doesn't change for 3 consecutive checks.
async function waitForDone(page, timeoutMs = 90000) {
  const STOP = [
    '[aria-label="Stop response"]',
    '[aria-label="Stop generating"]',
    '[aria-label="Stop streaming"]',
  ].join(', ');

  // Wait up to 12s for generation to start (stop button appears)
  let started = false;
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(500);
    if (await page.locator(STOP).count().catch(() => 0) > 0) { started = true; break; }
  }

  if (!started) {
    // Very fast response, or stop button not found — fall back to content stability
    await page.waitForTimeout(1500);
    let prev = null, same = 0;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const cur = await getResponseText(page).catch(() => '');
      if (prev !== null && cur === prev) { if (++same >= 2) return; } else same = 0;
      prev = cur;
    }
    return;
  }

  // Wait for the stop button to disappear (= generation complete)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(600);
    if (await page.locator(STOP).count().catch(() => 0) === 0) {
      await page.waitForTimeout(600); // small settling buffer
      return;
    }
  }
}

async function getResponseText(page) {
  const selectors = [
    'model-response message-content .markdown',
    'model-response .markdown',
    '.response-content .markdown',
    'model-response',
  ];
  for (const sel of selectors) {
    try {
      const els = page.locator(sel);
      if (await els.count() > 0) {
        const t = await els.last().innerText({ timeout: 2000 });
        if (t?.trim()) return t.trim();
      }
    } catch {}
  }
  return '';
}

// Snapshot all img srcs currently on the page (called BEFORE submitting the prompt)
async function snapshotImgSrcs(page) {
  return new Set(
    await page.evaluate(() =>
      [...document.querySelectorAll('img')].map(i => i.src).filter(Boolean)
    ).catch(() => [])
  );
}

// Save a base64 string to a temp file, return the path
function saveBase64(b64, mime) {
  const ext     = mime.includes('jpeg') ? 'jpg' : 'png';
  const tmpPath = path.join(os.tmpdir(), `walter_gemini_${Date.now()}.${ext}`);
  fs.writeFileSync(tmpPath, Buffer.from(b64, 'base64'));
  return tmpPath;
}

// Try every method to turn an img element into a local file
async function downloadImgElement(page, el) {
  try { await el.scrollIntoViewIfNeeded(); } catch {}
  await page.waitForTimeout(300);

  const src = await el.getAttribute('src').catch(() => null);

  if (src) {
    // 1. Inline base64
    const dm = src.match(/^data:(image\/[\w+]+);base64,(.+)$/);
    if (dm) return saveBase64(dm[2], dm[1]);

    // 2. Canvas draw-to-dataURL (preserves original resolution, works for blob: too)
    const dataUrl = await page.evaluate((url) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width  = img.naturalWidth  || img.width;
            c.height = img.naturalHeight || img.height;
            c.getContext('2d').drawImage(img, 0, 0);
            resolve(c.toDataURL('image/png'));
          } catch { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });
    }, src).catch(() => null);

    if (dataUrl && dataUrl.startsWith('data:image')) {
      return saveBase64(dataUrl.split(',')[1], 'image/png');
    }

    // 3. fetch() from within page (handles auth cookies for signed URLs)
    const fetched = await page.evaluate(async (url) => {
      try {
        const res  = await fetch(url);
        const buf  = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
        return { ok: true, b64: btoa(bin), mime: res.headers.get('content-type') || 'image/png' };
      } catch { return { ok: false }; }
    }, src).catch(() => ({ ok: false }));

    if (fetched.ok) return saveBase64(fetched.b64, fetched.mime);
  }

  // 4. Playwright element screenshot — always works, resolution = rendered size
  const tmpPath = path.join(os.tmpdir(), `walter_gemini_${Date.now()}.png`);
  await el.screenshot({ path: tmpPath });
  if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 2000) return tmpPath;

  return null;
}

// Find and download the generated image.
// knownSrcs = srcs that existed before the prompt was sent (so we skip pre-existing images).
// expectImage = true means we should screenshot the whole response if nothing else works.
async function extractImage(page, knownSrcs, expectImage = false) {
  await page.waitForTimeout(600); // let image finish rendering

  // Collect every img element; score by (is-new) + (is-large)
  const allImgs = page.locator('img');
  const count   = await allImgs.count().catch(() => 0);

  const candidates = [];
  for (let i = 0; i < count; i++) {
    const el  = allImgs.nth(i);
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 80 || box.height < 80) continue;
    const src   = await el.getAttribute('src').catch(() => '');
    const isNew = src && !knownSrcs.has(src);
    candidates.push({ el, box, src, isNew, area: box.width * box.height });
  }

  // Sort: new images first, then by descending area
  candidates.sort((a, b) => {
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    return b.area - a.area;
  });

  for (const { el } of candidates) {
    const filePath = await downloadImgElement(page, el).catch(() => null);
    if (filePath) return filePath;
  }

  // Absolute fallback for image-mode queries: screenshot the last model response
  if (expectImage) {
    try {
      const resp = page.locator('model-response').last();
      if (await resp.count() > 0) {
        await resp.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const tmpPath = path.join(os.tmpdir(), `walter_gemini_${Date.now()}.png`);
        await resp.screenshot({ path: tmpPath });
        if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 5000) return tmpPath;
      }
    } catch {}
  }

  return null;
}

let queryInFlight = false;

async function queryPlaywright(context, prompt, expectImage = false) {
  if (queryInFlight) throw new Error('A Gemini query is already in progress — please wait');
  queryInFlight = true;
  try {
    const page = await getOrOpenGeminiPage(context);

    // Wait until the input field is present (Gemini can be slow to hydrate)
    await page.waitForFunction(
      () => document.querySelectorAll('[contenteditable="true"], textarea').length > 0,
      { timeout: 12000 }
    ).catch(() => {});

    if (!page.url().includes('gemini.google.com')) {
      throw new Error('Not logged in to Gemini — sign in to Firefox first');
    }

    // Snapshot existing images so we can identify the newly generated one later
    const knownSrcs = await snapshotImgSrcs(page);

    const input = await findInput(page);
    await input.click();
    await input.fill('');
    await page.keyboard.type(prompt, { delay: 20 });
    await page.keyboard.press('Enter');

    await waitForDone(page);

    // For image queries: try every extraction method (including response-area screenshot fallback)
    if (expectImage) {
      const imagePath = await extractImage(page, knownSrcs, true);
      if (imagePath) return { type: 'image', path: imagePath };
      throw new Error('Gemini generated the image but download failed — check Firefox');
    }

    // For text queries: also opportunistically grab an image if one appeared
    const imagePath = await extractImage(page, knownSrcs, false);
    if (imagePath) return { type: 'image', path: imagePath };

    const text = await getResponseText(page);
    if (!text) throw new Error('No response received from Gemini');
    return { type: 'text', text };
  } finally {
    queryInFlight = false;
  }
}

// ── Win32 fallback (Firefox running, no CDP) ───────────────────────────────────

async function openGeminiWin32() {
  await switchTo('firefox');
  await sleep(400);
  await sendHotkey('ctrl+t');
  await sleep(350);
  await sendHotkey('ctrl+l');
  await sleep(200);
  await injectText('gemini.google.com/app', { submit: true });
  await sleep(4000);
}

async function pollClipboard(prompt, timeoutMs = 60000) {
  await sleep(2500);
  let prevLen = 0, stable = 0;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2500);
    await sendHotkey('ctrl+a'); await sleep(120);
    await sendHotkey('ctrl+c'); await sleep(150);
    const clip = await runPS('Get-Clipboard').catch(() => '');
    if (clip.length > 80 && clip.length === prevLen) {
      if (++stable >= 3) return parseClipboard(clip, prompt);
    } else stable = 0;
    prevLen = clip.length;
  }
  await sendHotkey('ctrl+a'); await sleep(120);
  await sendHotkey('ctrl+c'); await sleep(200);
  return parseClipboard(await runPS('Get-Clipboard').catch(() => ''), prompt);
}

function parseClipboard(text, prompt) {
  if (!text || text.length < 20) return '(no response captured)';
  const idx = text.indexOf(prompt);
  if (idx !== -1) {
    let after = text.slice(idx + prompt.length).trim();
    for (const stop of ['\nCopy\n', '\nShare\n', '\nMore\n', '\nAsk Gemini\n', '\nGemini\n']) {
      const si = after.indexOf(stop);
      if (si > 10) after = after.slice(0, si).trim();
    }
    if (after.length > 10) return after;
  }
  return text.slice(-2000).trim();
}

// Capture the Firefox window as a PNG using GDI+ — no CDP needed.
async function captureFirefoxWindow() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class WC {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
'@ -ErrorAction SilentlyContinue
$proc = Get-Process firefox -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output ""; exit }
$r = New-Object WC+RECT
[WC]::GetWindowRect($proc.MainWindowHandle, [ref]$r)
$w = $r.R - $r.L; $h = $r.B - $r.T
if ($w -lt 100 -or $h -lt 100) { Write-Output ""; exit }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, [System.Drawing.Size]::new($w, $h))
$g.Dispose()
$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "walter_gemini_$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).png")
$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output $tmp`.trimStart();
  const result = await runPS(script).catch(() => '');
  const p = result.trim();
  return (p && fs.existsSync(p) && fs.statSync(p).size > 10000) ? p : null;
}

async function queryWin32(prompt, expectImage = false) {
  await openGeminiWin32();
  await pressKey('escape');
  await sleep(150);
  await injectText(prompt, { submit: true });

  if (expectImage) {
    // No DOM access — wait for generation then screenshot the Firefox window
    await sleep(35000);
    const imgPath = await captureFirefoxWindow();
    if (imgPath) return { type: 'image', path: imgPath };
    return { type: 'text', text: 'Image generated in Gemini — open Firefox to view it (CDP unavailable for download)' };
  }

  const text = await pollClipboard(prompt);
  return { type: 'text', text };
}

// ── Main entry point ───────────────────────────────────────────────────────────

async function query(prompt, { expectImage = false } = {}) {
  // 1. Reuse our owned Playwright context (or launch Firefox with real profile if not running)
  const owned = await getOwnedContext();
  if (owned) return queryPlaywright(owned, prompt, expectImage);

  // 2. Firefox is running — try to connect via CDP for full DOM access
  const cdp = await getCDPContext();
  if (cdp) return queryPlaywright(cdp, prompt, expectImage);

  // 3. Firefox running without CDP — Win32 automation (text via clipboard, image via window capture)
  console.warn('WALTER: Firefox running without CDP — using Win32 fallback. ' +
    'Close Firefox and let WALTER relaunch it for full image download support.');
  return queryWin32(prompt, expectImage);
}

// Expose the live Playwright context so other modules (e.g. tool_browser) can reuse it.
// Returns null if Firefox was not launched by WALTER (user opened it themselves).
function getContext() { return ctx; }

module.exports = { query, getContext };
