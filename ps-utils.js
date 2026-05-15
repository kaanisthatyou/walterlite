const { spawn } = require('child_process');

function runPS(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true });
    let out = '', err = '';
    proc.stdout?.on('data', d => { out += d; });
    proc.stderr?.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `ps exit ${code}`)));
    proc.on('error', reject);
  });
}

module.exports = { runPS };
