// Claude Code CLI runner — sends a prompt via `claude -p` and returns the response.
// Requires Claude Code to be installed and authenticated (`claude` in PATH).

const { spawn } = require('child_process');

const TIMEOUT_MS = 120000; // 2 min — Claude can take a while

async function askClaudeCLI(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--dangerously-skip-permissions', prompt], {
      shell: true,
      windowsHide: true,
      env: { ...process.env },
    });

    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('Claude CLI timed out after 2 minutes'));
    }, TIMEOUT_MS);

    proc.stdout?.on('data', d => { out += d; });
    proc.stderr?.on('data', d => { err += d; });

    proc.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(out.trim());
      } else {
        const msg = err.trim() || out.trim() || `Claude CLI exited with code ${code}`;
        reject(new Error(msg.slice(0, 200)));
      }
    });

    proc.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e.code === 'ENOENT') {
        reject(new Error('claude not found in PATH — install Claude Code and run: claude login'));
      } else {
        reject(e);
      }
    });
  });
}

module.exports = { askClaudeCLI };
