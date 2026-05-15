const { spawn } = require('child_process');

// Character-by-character Win32 injection. submit=true adds Enter at the end.
async function injectText(text, { submit = true } = {}) {
  const textB64   = Buffer.from(text, 'utf8').toString('base64');
  const submitArg = submit ? '$true' : '$false';

  const script = `
$bytes = [Convert]::FromBase64String('${textB64}')
$text = [System.Text.Encoding]::UTF8.GetString($bytes).TrimEnd()
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class M {
    [StructLayout(LayoutKind.Explicit, Size=40)]
    struct I { [FieldOffset(0)] public uint t; [FieldOffset(8)] public ushort vk; [FieldOffset(10)] public ushort sc; [FieldOffset(12)] public uint fl; [FieldOffset(16)] public uint time; [FieldOffset(24)] public IntPtr ex; }
    [DllImport("user32.dll")] static extern uint SendInput(uint n, I[] a, int s);
    static void K(ushort vk, ushort sc, uint fl) { var a=new I[2]; a[0].t=1;a[0].vk=vk;a[0].sc=sc;a[0].fl=fl; a[1].t=1;a[1].vk=vk;a[1].sc=sc;a[1].fl=fl|2; SendInput(2,a,40); }
    public static void Go(string s, bool submit) { foreach(char c in s) K(0,(ushort)c,4); if(submit) K(0,0x1C,8); }
}
'@ -ErrorAction SilentlyContinue
[M]::Go($text, ${submitArg})
`.trimStart();

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Minimized', '-EncodedCommand', encoded],
      { windowsHide: false });
    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d; });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `ps exit ${code}`)));
    proc.on('error', reject);
  });
}

// Clipboard-based injection: fast for long text; submit=false by default.
async function pasteText(text, { submit = false } = {}) {
  const textB64 = Buffer.from(text, 'utf8').toString('base64');
  const enterLine = submit
    ? `Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`
    : '';

  const script = `
$bytes = [Convert]::FromBase64String('${textB64}')
$t = [System.Text.Encoding]::UTF8.GetString($bytes)
Set-Clipboard -Value $t
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
${enterLine}
`.trimStart();

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true });
    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d; });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `ps exit ${code}`)));
    proc.on('error', reject);
  });
}

module.exports = { injectText, pasteText };
