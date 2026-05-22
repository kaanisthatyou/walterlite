const { runPS }      = require('../ps-utils');
const { switchTo }   = require('../windows');
const { sendHotkey } = require('../keyboard');
const { pasteText }  = require('../inject');

// Ensures any URL string has a protocol so new URL() can parse it.
// Bare IP:port and localhost → http, everything else → https.
function normalizeUrl(raw) {
  const s = (raw || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(s)) return s;
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

// Reuse the Playwright BrowserContext owned by gemini-browser.js.
// Returns null when Firefox was not launched by WALTER (user opened it themselves).
function getSharedContext() {
  try { return require('../gemini-browser').getContext(); } catch { return null; }
}

// ── Search URL builder ────────────────────────────────────────────────────────

const SEARCH_URLS = {
  youtube:   (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  google:    (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  reddit:    (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
  twitter:   (q) => `https://twitter.com/search?q=${encodeURIComponent(q)}`,
  x:         (q) => `https://x.com/search?q=${encodeURIComponent(q)}`,
  github:    (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
  wikipedia: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
  imdb:      (q) => `https://www.imdb.com/find/?q=${encodeURIComponent(q)}`,
};

// Selectors tried in priority order when clicking the first result.
const CLICK_SELECTORS = [
  'ytd-video-renderer a#video-title',       // YouTube search results
  'ytd-rich-item-renderer a#video-title',   // YouTube home / recommendations
  '.g a h3',                                // Google search results
  'div[data-sokoban-container] a h3',       // Google (alternate layout)
  '[data-testid="tweet"] a[href*="/status"]', // Twitter/X
  '.Post a[data-click-id="body"]',          // Reddit
  'article h2 a', 'article h3 a',
  'h3 > a[href]', 'h2 > a[href]',
];

// ── Core navigation ───────────────────────────────────────────────────────────
// Tries Playwright first (returns screenshot + starts/continues session).
// Falls back to Win32 paste-into-addressbar when Playwright isn't reachable.

async function openUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('open_url: no URL provided — extraction likely failed');
  }
  const url = normalizeUrl(rawUrl.trim());

  // Bare-domain guard: skip for local IPs/ports (user typed it explicitly).
  // For public URLs, reject bare video domains with no path — likely an extraction failure.
  const VIDEO_DOMAINS = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)(\/|$)/i;
  if (!isLocalAddress(url)) {
    try {
      const u = new URL(url);
      if (VIDEO_DOMAINS.test(url) && (u.pathname === '' || u.pathname === '/') && !u.search && !u.hash) {
        throw new Error(`open_url: "${url}" is a bare video domain with no path — URL extraction failed`);
      }
    } catch (e) {
      if (e.message.startsWith('open_url:')) throw e;
      throw new Error(`open_url: malformed URL "${url}"`);
    }
  }

  // Playwright path: navigates in the active tab and returns a screenshot.
  // This also implicitly starts/continues the Playwright session so follow-up
  // session_step commands work without an explicit start_session call.
  try {
    const { ensureSession } = require('../playwright-session');
    const result = await ensureSession({ url });
    // ensureSession returns { photo, caption } when a URL is provided
    if (result && result.photo) return result;
  } catch {
    // Playwright not reachable — fall through to Win32
  }

  // Win32 fallback: use browser-detector to find and navigate the browser
  let detected;
  try { detected = require('../browser-detector').best(); } catch { detected = null; }
  const processName = detected ? detected.processName : 'chrome';

  const count = await runPS(
    `(Get-Process ${processName} -ErrorAction SilentlyContinue | Measure-Object).Count`
  ).catch(() => '0');

  if (parseInt(count.trim(), 10) > 0) {
    await switchTo(processName);
    await new Promise(r => setTimeout(r, 200));
    await sendHotkey('ctrl+l');
    await new Promise(r => setTimeout(r, 200));
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
}

// ── Generic browser tools ─────────────────────────────────────────────────────

// Navigate to a site's search results with properly encoded query.
// Uses Playwright (new tab in shared context) when available, Win32 otherwise.
async function browserSearch(site, query) {
  const key = site.toLowerCase().replace(/\.(com|org|net|io).*$/, '');
  const urlFn = SEARCH_URLS[key]
    || ((q) => `https://www.${key}.com/search?q=${encodeURIComponent(q)}`);
  const url = urlFn(query);

  const ctx = getSharedContext();
  if (ctx) {
    // Open a new tab so we don't clobber an existing Gemini session
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.bringToFront();
    return `Searched ${site} for: ${query}`;
  }

  return openUrl(url);
}

// Click the first visible result on any page in the shared Playwright context.
// Scans pages newest-first, tries selectors in priority order.
async function browserClickFirst() {
  const ctx = getSharedContext();
  if (!ctx) throw new Error(
    'No Playwright context — close Firefox and let WALTER reopen it, then retry.'
  );

  const pages = [...ctx.pages()].reverse(); // newest tab first

  for (const selector of CLICK_SELECTORS) {
    for (const page of pages) {
      try {
        const loc = page.locator(selector).first();
        await loc.waitFor({ state: 'visible', timeout: 800 });
        await page.bringToFront();
        await loc.click();
        return 'Clicked first result';
      } catch { /* try next selector / page */ }
    }
  }

  throw new Error('No clickable result found on any open tab');
}

module.exports = { openUrl, browserSearch, browserClickFirst };
