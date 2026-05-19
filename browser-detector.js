const fs      = require('fs');
const path    = require('path');
const memory  = require('./memory');

const LOCAL   = process.env.LOCALAPPDATA || '';
const APPDATA = process.env.APPDATA      || '';
const PF      = process.env.ProgramFiles || 'C:\\Program Files';
const PF86    = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

// Browsers in priority order. Chromium-based first — CDP is more stable than Firefox CDP.
const BROWSER_DEFS = [
  {
    name: 'chrome',
    api: 'chromium',
    processName: 'chrome',
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
    processName: 'msedge',
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
    processName: 'opera',
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
    processName: 'brave',
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
    processName: 'firefox',
    exePaths: [
      process.env.FIREFOX_PATH,
      path.join(PF,   'Mozilla Firefox', 'firefox.exe'),
      path.join(PF86, 'Mozilla Firefox', 'firefox.exe'),
    ].filter(Boolean),
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
  if (cached && Array.isArray(cached) && cached.length > 0) {
    if (fs.existsSync(cached[0].exePath)) return cached;
    // Stale cache — re-scan
    memory.set('system', '__browsers', null);
  }

  const found = [];
  for (const def of BROWSER_DEFS) {
    const exePath = def.exePaths.find(p => fs.existsSync(p));
    if (!exePath) continue;
    found.push({
      name:        def.name,
      api:         def.api,
      processName: def.processName,
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

// Clears the cached browser list (call after installing a new browser).
function clearCache() {
  memory.set('system', '__browsers', null);
}

module.exports = { detect, best, clearCache };
