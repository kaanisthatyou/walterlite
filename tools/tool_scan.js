const http   = require('http');
const https  = require('https');
const memory = require('../memory');
const { runPS }  = require('../ps-utils');
const { askLLM } = require('./tool_llm');

// Directory aliases → PowerShell expression that resolves to the path
const DIR_ALIASES = {
  desktop:         `[Environment]::GetFolderPath('Desktop')`,
  'masaüstü':      `[Environment]::GetFolderPath('Desktop')`,
  downloads:       `"$env:USERPROFILE\\Downloads"`,
  indirmeler:      `"$env:USERPROFILE\\Downloads"`,
  documents:       `[Environment]::GetFolderPath('MyDocuments')`,
  belgeler:        `[Environment]::GetFolderPath('MyDocuments')`,
  'program files': `$env:ProgramFiles`,
  programs:        `$env:ProgramFiles`,
  localappdata:    `$env:LOCALAPPDATA`,
};

// Scans a directory for .exe and .lnk files, saves each to memory["apps"].
// Never overwrites an entry that already exists in memory.
async function scanPath(directory) {
  const lower = (directory || 'desktop').toLowerCase().trim();
  const psDir = DIR_ALIASES[lower] || `"${directory}"`;

  const script = `
$dir   = ${psDir}
$items = Get-ChildItem "$dir\\*" -Include "*.exe","*.lnk" -ErrorAction SilentlyContinue
# Recurse one level but skip known dev/build noise directories
$items += Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notmatch '^(node_modules|target|dist|build|\.git|__pycache__)$' } |
  ForEach-Object { Get-ChildItem "$($_.FullName)\\*" -Include "*.exe","*.lnk" -ErrorAction SilentlyContinue }
$seen = @{}
foreach ($f in $items) {
  $p = $f.FullName
  # Skip paths inside build/dev artifact directories
  if ($p -match '\\(node_modules|\\target\\|dist\\win-unpacked|build_script|\.asar)') { continue }
  # Skip names that look like build artifacts (hex hashes, build_script_build-)
  if ($f.BaseName -match '^build_script|^build-script|-[0-9a-f]{16}$') { continue }
  $key = $f.BaseName.ToLower()
  if (-not $seen[$key]) {
    $seen[$key] = $true
    Write-Output "$($f.BaseName)|$p"
  }
}`.trimStart();

  const output = await runPS(script).catch(() => '');
  if (!output?.trim()) return `"${directory}" tarandı — hiçbir uygulama bulunamadı.`;

  const lines  = output.trim().split(/\r?\n/).filter(l => l.includes('|'));
  let newCount = 0;

  for (const line of lines) {
    const pipe    = line.indexOf('|');
    const name    = line.slice(0, pipe).trim().toLowerCase();
    const path    = line.slice(pipe + 1).trim();
    if (!name || !path) continue;
    if (!memory.get('apps', name)) {
      memory.set('apps', name, path);
      newCount++;
    }
  }

  return `"${directory}" tarandı: ${lines.length} uygulama bulundu, ${newCount} yeni kaydedildi.`;
}

// Fetches a URL, derives a short label via LLM, saves to memory["sites"].
async function scanPage(url, hint) {
  if (!url || typeof url !== 'string') throw new Error('scan_page: URL gerekli');

  const html = await fetchHTML(url);

  const titleMatch = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
  const title      = titleMatch?.[1]?.trim().replace(/\s+/g, ' ') || '';

  const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,200})["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']{1,200})["'][^>]+name=["']description["']/i);
  const desc = metaMatch?.[1]?.trim() || '';

  const context = [title, desc, hint].filter(Boolean).join(' | ');
  const raw = await askLLM(
    `Website info: "${context}", URL: "${url}". ` +
    `Return ONLY a single lowercase key to store this site under (examples: "sahibinden", "google_calendar", "hbys", "youtube"). ` +
    `No explanation, no punctuation, just the key.`
  );

  const key = raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 32);
  memory.set('sites', key, url);

  return `Kaydedildi: "${key}" → ${url}`;
}

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      // Follow one redirect
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchHTML(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 80_000) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('fetch timeout')));
  });
}

module.exports = { scanPath, scanPage };
