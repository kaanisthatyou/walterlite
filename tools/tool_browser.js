const { runPS }      = require('../ps-utils');
const { switchTo }   = require('../windows');
const { sendHotkey } = require('../keyboard');
const { pasteText }  = require('../inject');

const FIREFOX_PATH = process.env.FIREFOX_PATH || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

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

// ── Core Win32 navigation ─────────────────────────────────────────────────────

async function openUrl(url) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    throw new Error('open_url: no URL provided — extraction likely failed');
  }
  try {
    const u = new URL(url.trim());
    if ((u.pathname === '' || u.pathname === '/') && !u.search && !u.hash) {
      throw new Error(`open_url: "${url}" is a bare domain with no path — video URL extraction failed`);
    }
  } catch (e) {
    if (e.message.startsWith('open_url:')) throw e;
    throw new Error(`open_url: malformed URL "${url}"`);
  }

  const count = await runPS(
    '(Get-Process firefox -ErrorAction SilentlyContinue | Measure-Object).Count'
  ).catch(() => '0');

  if (parseInt(count.trim(), 10) > 0) {
    await switchTo('firefox');
    await new Promise(r => setTimeout(r, 500));
    await sendHotkey('ctrl+l');
    await new Promise(r => setTimeout(r, 400));
    await pasteText(url, { submit: true });
  } else {
    const escaped = url.replace(/'/g, "''");
    await runPS(`Start-Process "${FIREFOX_PATH}" -ArgumentList '${escaped}'`);
    await new Promise(r => setTimeout(r, 3000));
    await switchTo('firefox').catch(() => {});
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
