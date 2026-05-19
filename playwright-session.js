// Playwright remote-control session.
//
// Design principle: zero friction.
// - ensureSession() acquires a browser connection without requiring an explicit "start session"
//   command from the user. It tries CDP, then owned context, then launches Firefox.
// - executeStep() auto-calls ensureSession() — user can say "click 'Kapat'" on ANY active tab
//   without ever saying "start session" first.
// - open_url (tool_browser.js) calls ensureSession() so URL navigation implicitly activates
//   the Playwright session and returns a screenshot.
// - Element finding uses multi-strategy DOM traversal: text > role > LLM selector — brittle
//   CSS ids/classes are the last resort, not the first.

const { chromium, firefox } = require('playwright-core');
const browserDetector        = require('./browser-detector');
const path        = require('path');
const os          = require('os');
const fs          = require('fs');
const { runPS }   = require('./ps-utils');
const { askLLM }  = require('./tools/tool_llm');
const memory      = require('./memory');

// ── Module-level state ────────────────────────────────────────────────────────

let sessionPage     = null;
let _ownedCtx       = null;   // Playwright context launched by this module
let recordingBuffer = [];
let sessionActive   = false;

// ── Browser helpers ───────────────────────────────────────────────────────────

async function isBrowserRunning() {
  let detected;
  try { detected = browserDetector.best(); } catch { return false; }
  const processName = require('path').basename(detected.exePath, '.exe').toLowerCase();
  const out = await runPS(
    `(Get-Process ${processName} -ErrorAction SilentlyContinue | Measure-Object).Count`
  ).catch(() => '0');
  return parseInt(out.trim(), 10) > 0;
}

// ── Context acquisition (never throws if any path works) ─────────────────────

async function acquireContext() {
  // 1. Reuse gemini-browser's owned context (already launched by us)
  try {
    const { getContext } = require('./gemini-browser');
    const ownedCtx = getContext();
    if (ownedCtx) { ownedCtx.pages(); return ownedCtx; }
  } catch {}

  // 2. Connect via CDP (browser running with --remote-debugging-port=9222)
  try {
    let detected;
    try { detected = browserDetector.best(); } catch { detected = null; }
    const pw = (detected?.api === 'firefox') ? firefox : chromium;
    const browser = await pw.connectOverCDP('http://localhost:9222', { timeout: 2000 });
    const contexts = browser.contexts();
    return contexts.length > 0 ? contexts[0] : await browser.newContext();
  } catch {}

  // 3. Launch browser with real profile (only when it isn't running)
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
}

// ── Active page detection ─────────────────────────────────────────────────────

// Returns the currently focused (or most recently used) page from a context.
async function pickActivePage(context) {
  const pages = context.pages();
  if (pages.length === 0) return await context.newPage();

  // Try to find the page that actually has focus
  for (const page of [...pages].reverse()) {
    try {
      const focused = await page.evaluate(() => document.hasFocus());
      if (focused) return page;
    } catch {}
  }

  // Fall back to the last page (most recently opened/activated)
  return pages[pages.length - 1];
}

// ── Core: ensureSession ───────────────────────────────────────────────────────
// The main entry point for all browser control.
// - Acquires a context (CDP / owned / fresh launch)
// - Sets sessionPage to the active/last page (or navigates if url given)
// - If a valid sessionPage already exists, reuses it without touching the browser
// - Returns { photo, caption } when url is provided, otherwise returns the page

async function ensureSession({ url } = {}) {
  // If we already have a live page and no new URL to navigate to, just return it
  if (sessionPage && !sessionPage.isClosed() && !url) {
    sessionActive = true;
    return sessionPage;
  }

  const context = await acquireContext();

  if (url) {
    // Navigate in the existing active tab (or a new tab if none exist)
    const page = await pickActivePage(context);
    sessionPage   = page;
    sessionActive = true;
    if (!recordingBuffer.length) recordingBuffer = [];
    await sessionPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    recordStep('navigate', { url });
    const screenshot = await takePageScreenshot();
    return { photo: screenshot, caption: sessionPage.url() };
  }

  // No URL: just latch onto the active page
  sessionPage   = await pickActivePage(context);
  sessionActive = true;
  return sessionPage;
}

// ── Page helpers ──────────────────────────────────────────────────────────────

async function takePageScreenshot() {
  if (!sessionPage) throw new Error('Aktif oturum sayfası yok');
  const tmpPath = path.join(os.tmpdir(), `walter_session_${Date.now()}.png`);
  await sessionPage.screenshot({ path: tmpPath });
  return tmpPath;
}

async function getPageContext() {
  if (!sessionPage) return '';
  const url   = sessionPage.url();
  const title = await sessionPage.title().catch(() => '');
  const body  = await sessionPage.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node;
    while ((node = walker.nextNode()) && parts.join('').length < 1500) {
      const t = node.textContent.trim();
      if (t.length > 1) parts.push(t);
    }
    return parts.join(' ').replace(/\s+/g, ' ').slice(0, 1500);
  }).catch(() => '');
  return `URL: ${url}\nBaşlık: ${title}\nGörünür metin: ${body}`;
}

function recordStep(action, params) {
  recordingBuffer.push({
    action,
    params,
    timestamp: Date.now(),
    url: sessionPage?.url() || '',
  });
}

// ── Multi-strategy element finder ─────────────────────────────────────────────
// When the user says "click 'Kapat'", we try DOM-traversal approaches in order
// of reliability. We never give up on just the LLM's first selector guess.

async function findElement(page, selector, textHint) {
  // Build candidate locators, most reliable first
  const candidates = [];

  // Text-based strategies (always reliable when we know the label)
  if (textHint) {
    candidates.push(
      page.locator(`button:has-text("${textHint}")`).first(),
      page.locator(`a:has-text("${textHint}")`).first(),
      page.locator(`[type="submit"]:has-text("${textHint}")`).first(),
      page.locator(`span:has-text("${textHint}")`).first(),
      page.locator(`[role="button"]:has-text("${textHint}")`).first(),
      page.getByRole('button', { name: textHint }),
      page.getByRole('link', { name: textHint }),
      page.getByText(textHint, { exact: false }).first(),
    );
  }

  // LLM-suggested selector (may be brittle but worth trying)
  if (selector && selector !== textHint) {
    candidates.push(page.locator(selector).first());
  }

  for (const locator of candidates) {
    try {
      if (await locator.count() > 0 && await locator.isVisible({ timeout: 800 })) {
        return locator;
      }
    } catch {}
  }

  // Last resort: extract ALL interactive elements from DOM, ask LLM to pick.
  // This handles elements with dynamic ids, translated labels, or unusual markup.
  const domEls = await page.evaluate(() => {
    const q = 'button, a[href], input:not([type="hidden"]), select, ' +
      '[role="button"], [role="link"], [role="menuitem"], [role="tab"]';
    return [...document.querySelectorAll(q)].slice(0, 60).map((el, i) => {
      const text = (
        el.textContent?.trim() ||
        el.value?.trim() ||
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') || ''
      ).slice(0, 80).replace(/\s+/g, ' ');
      const rect = el.getBoundingClientRect();
      return {
        i,
        tag: el.tagName.toLowerCase(),
        text,
        id: el.id || null,
        visible: rect.width > 0 && rect.height > 0,
      };
    }).filter(el => el.text && el.visible);
  }).catch(() => []);

  if (domEls.length) {
    const prompt =
      `Aranan eleman: "${textHint || selector}"\n` +
      `Sayfadaki görünür etkileşimli elemanlar:\n` +
      domEls.map(e => `${e.i}: [${e.tag}] "${e.text}"${e.id ? ` id="${e.id}"` : ''}`).join('\n') +
      `\n\nSadece en iyi eşleşen elemanın indeks numarasını yaz (0-${domEls.length - 1}). ` +
      `Hiçbiri uygun değilse -1. Açıklama yok.`;

    const raw = await askLLM(prompt);
    const idx = parseInt(raw.trim().match(/-?\d+/)?.[0] ?? '-1');

    if (idx >= 0 && idx < domEls.length) {
      const match = domEls[idx];
      // Build the most stable selector for this element
      if (match.id) return page.locator(`#${CSS.escape ? CSS.escape(match.id) : match.id}`).first();
      const shortText = match.text.slice(0, 40);
      const byText = page.locator(`${match.tag}:has-text("${shortText}")`).first();
      if (await byText.count() > 0) return byText;
      return page.locator(match.tag).filter({ hasText: shortText }).first();
    }
  }

  // Still nothing — tell user what buttons are on the page
  const labels = domEls.map(e => e.text).slice(0, 10);
  const hint   = labels.length ? ` Sayfadaki elemanlar: ${labels.join(', ')}` : '';
  throw new Error(`Element bulunamadı: "${textHint || selector}".${hint}`);
}

// ── NL → action parser ────────────────────────────────────────────────────────

async function parseInstruction(instruction) {
  const pageCtx = await getPageContext();
  const prompt =
    `Firefox tarayıcısını Playwright ile kontrol ediyorsun. Mevcut sayfa:\n${pageCtx}\n\n` +
    `Kullanıcı talimatı: "${instruction}"\n\n` +
    `Sadece geçerli JSON döndür (açıklama veya markdown yok):\n` +
    `{\n` +
    `  "action": "click|fill|press|scroll|navigate|select|hover|wait",\n` +
    `  "selector": "CSS/metin seçici, örn: button:has-text(\\"Giriş\\") ya da input[name='user']",\n` +
    `  "text": "eleman üzerindeki görünür metin (click için) — ör: 'Kapat', 'Giriş Yap'",\n` +
    `  "value": "yazılacak metin, gidilecek URL, tuş adı (Enter/Tab), ya da scroll için up/down",\n` +
    `  "description": "bu adımın Türkçe açıklaması"\n` +
    `}\n` +
    `"text" alanı: tıklanacak elemanın üzerindeki insan okuyabilir metin, ` +
    `selector gibi yazılmış bir şey değil. ` +
    `"selector" alanında :has-text() gibi metin tabanlı seçicileri tercih et, ` +
    `kırılgan id/class seçicilerden kaçın. Yalnızca action için gerekli alanları ekle.`;

  const raw   = await askLLM(prompt);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Talimat ayrıştırılamadı: ${raw.slice(0, 80)}`);
  return JSON.parse(match[0]);
}

async function applyAction(parsed) {
  const { action, selector, text: textHint, value } = parsed;
  switch (action) {
    case 'navigate':
      await sessionPage.goto(value, { waitUntil: 'domcontentloaded', timeout: 20000 });
      break;
    case 'click': {
      const el = await findElement(sessionPage, selector, textHint);
      await el.click({ timeout: 8000 });
      break;
    }
    case 'fill': {
      const el = await findElement(sessionPage, selector, textHint);
      await el.fill(value || '', { timeout: 8000 });
      break;
    }
    case 'press':
      if (selector && selector !== 'body') {
        const el = await findElement(sessionPage, selector, textHint);
        await el.press(value, { timeout: 5000 });
      } else {
        await sessionPage.keyboard.press(value);
      }
      break;
    case 'select': {
      const el = await findElement(sessionPage, selector, textHint);
      await el.selectOption(value, { timeout: 5000 });
      break;
    }
    case 'hover': {
      const el = await findElement(sessionPage, selector, textHint);
      await el.hover({ timeout: 5000 });
      break;
    }
    case 'scroll':
      if (value === 'up') await sessionPage.evaluate(() => window.scrollBy(0, -400));
      else await sessionPage.evaluate(() => window.scrollBy(0, 400));
      break;
    case 'wait':
      await sessionPage.waitForTimeout(parseInt(value) || 1000);
      break;
    default:
      throw new Error(`Bilinmeyen action: ${action}`);
  }
  await sessionPage.waitForTimeout(500);
}

// ── Public API ────────────────────────────────────────────────────────────────

// start_session: explicit navigation to a URL — kept for backward compat but
// ensureSession({ url }) is what tools now call internally.
async function startSession({ url }) {
  if (!url || !url.startsWith('http')) {
    throw new Error('start_session: geçerli bir URL (http...) gerekli');
  }
  // Reset recording when user explicitly starts a new named session
  recordingBuffer = [];
  return ensureSession({ url });
}

async function executeStep({ instruction }) {
  if (!instruction) throw new Error('session_step: instruction gerekli');

  // Auto-connect: user doesn't need to say "start session" first
  if (!sessionPage || sessionPage.isClosed() || !sessionActive) {
    await ensureSession();
  }

  const parsed = await parseInstruction(instruction);
  await applyAction(parsed);
  recordStep(parsed.action, {
    selector: parsed.selector,
    text:     parsed.text,
    value:    parsed.value,
  });
  const screenshot = await takePageScreenshot();
  return { photo: screenshot, caption: parsed.description || parsed.action };
}

async function saveRecording({ name }) {
  if (!name) throw new Error('save_recording: name gerekli');
  const key = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
  memory.set('macros', key, {
    steps:     [...recordingBuffer],
    savedAt:   Date.now(),
    stepCount: recordingBuffer.length,
  });
  return `Makro kaydedildi: "${key}" — ${recordingBuffer.length} adım`;
}

async function replayRecording({ name }) {
  if (!name) throw new Error('replay_recording: name gerekli');
  const key   = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
  const macro = memory.get('macros', key);
  if (!macro) throw new Error(`Makro "${key}" bulunamadı — önce save_recording ile kaydedin`);

  // Auto-connect if not already in a session
  if (!sessionPage || sessionPage.isClosed() || !sessionActive) {
    await ensureSession();
  }

  for (const step of macro.steps) {
    const { action, params } = step;
    try {
      switch (action) {
        case 'navigate':
          await sessionPage.goto(params.url || params.value, { waitUntil: 'domcontentloaded', timeout: 20000 });
          break;
        case 'click': {
          const el = await findElement(sessionPage, params.selector, params.text);
          await el.click({ timeout: 8000 });
          break;
        }
        case 'fill': {
          const el = await findElement(sessionPage, params.selector, params.text);
          await el.fill(params.value || '', { timeout: 8000 });
          break;
        }
        case 'press':
          if (params.selector && params.selector !== 'body') {
            const el = await findElement(sessionPage, params.selector, params.text);
            await el.press(params.value, { timeout: 5000 });
          } else {
            await sessionPage.keyboard.press(params.value);
          }
          break;
        case 'scroll':
          if (params.value === 'up') await sessionPage.evaluate(() => window.scrollBy(0, -400));
          else await sessionPage.evaluate(() => window.scrollBy(0, 400));
          break;
      }
      await sessionPage.waitForTimeout(300);
    } catch {
      // Partial replay is better than a full stop
    }
  }

  const screenshot = await takePageScreenshot();
  return { photo: screenshot, caption: `${macro.steps.length} adım tekrarlandı: ${key}` };
}

function stopSession() {
  sessionActive   = false;
  sessionPage     = null;
  recordingBuffer = [];
  return 'Oturum sonlandırıldı.';
}

// ── DOM inspection tools ──────────────────────────────────────────────────────

// Returns a structured list of all interactive elements on the current page.
// When save_as_prefix is provided, also writes a prefix entry to prefixes.json.
async function domInspect({ save_as_prefix } = {}) {
  if (!sessionPage || sessionPage.isClosed() || !sessionActive) {
    await ensureSession();
  }

  const url   = sessionPage.url();
  const title = await sessionPage.title().catch(() => '');

  const elements = await sessionPage.evaluate(() => {
    const q = 'button, a[href], input:not([type="hidden"]), select, ' +
      '[role="button"], [role="link"], [role="menuitem"], [role="tab"]';
    return [...document.querySelectorAll(q)].slice(0, 80).map(el => {
      const text = (
        el.textContent?.trim() ||
        el.value?.trim() ||
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') || ''
      ).slice(0, 80).replace(/\s+/g, ' ');
      const rect  = el.getBoundingClientRect();
      const sel   = el.id ? `#${el.id}` :
                    (el.tagName.toLowerCase() + (text ? `:has-text("${text.slice(0, 30)}")` : ''));
      return {
        tag:     el.tagName.toLowerCase(),
        text,
        id:      el.id || null,
        type:    el.type || null,
        selector: sel,
        visible: rect.width > 0 && rect.height > 0,
      };
    }).filter(el => el.text && el.visible);
  }).catch(() => []);

  if (save_as_prefix) {
    const key     = save_as_prefix.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const registry = require('./prefix-registry');
    // Turn each button/link into a one-click macro
    const macros  = elements
      .filter(e => e.tag === 'button' || e.tag === 'a')
      .slice(0, 8)
      .map(e => ({
        id:    e.text.toLowerCase().replace(/\W+/g, '_').replace(/^_|_$/g, '').slice(0, 24),
        label: e.text.slice(0, 32),
        steps: [{ action: 'click', selector: e.selector, text: e.text }],
      }));
    registry.set(key, { label: title || key, baseUrl: url, macros });
    return `✅ Prefix "${key}" oluşturuldu — ${macros.length} makro kaydedildi:\n` +
      macros.map(m => `• ${m.label}`).join('\n');
  }

  const lines = elements.map(e =>
    `• [${e.tag}${e.type ? ':' + e.type : ''}] ${e.text}`
  );
  return `${title || '(başlık yok)'} — ${url}\n\nEtkileşimli elemanlar (${elements.length}):\n${lines.join('\n')}`;
}

function isSessionActive()    { return sessionActive; }
function getRecordingBuffer() { return [...recordingBuffer]; }

module.exports = {
  ensureSession,
  startSession,
  executeStep,
  saveRecording,
  replayRecording,
  stopSession,
  domInspect,
  isSessionActive,
  getRecordingBuffer,
  // Exported for macro-runner.js
  findElement,
  takePageScreenshot,
};
