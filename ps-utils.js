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
    proc.on('close', code => {
      if (code === 0) return resolve(out.trim());
      // PowerShell formats errors as CLIXML when invoked non-interactively.
      // Strip the XML wrapper and extract the readable message.
      let msg = err.trim();
      if (msg.startsWith('#< CLIXML')) {
        msg = msg
          .replace(/#< CLIXML\s*/g, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      reject(new Error(msg || `ps exit ${code}`));
    });
    proc.on('error', reject);
  });
}

module.exports = { runPS };
