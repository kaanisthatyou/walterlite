const { runPS } = require('../ps-utils');

async function readClipboard() {
  return runPS('Get-Clipboard');
}

async function writeClipboard(text) {
  const escaped = text.replace(/'/g, "''");
  await runPS(`Set-Clipboard -Value '${escaped}'`);
  return text;
}

module.exports = { readClipboard, writeClipboard };
