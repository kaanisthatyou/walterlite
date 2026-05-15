const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');

function readEnv() {
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    const result = {};
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    return result;
  } catch {
    return {};
  }
}

function writeEnv(updates) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}

  const lines = content.split(/\r?\n/);
  const written = new Set();

  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return line;
    const key = trimmed.slice(0, idx).trim();
    if (key in updates) {
      written.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key)) newLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(ENV_PATH, newLines.join('\n'), 'utf8');
}

module.exports = { readEnv, writeEnv };
