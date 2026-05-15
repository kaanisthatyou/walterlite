const { runPS } = require('../ps-utils');

// Find a file by partial name on Desktop, Documents, or Downloads, then open it.
async function openFile(name) {
  const nameB64 = Buffer.from(name, 'utf8').toString('base64');
  const script = `
$name = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${nameB64}'))
$locations = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('MyDocuments'),
  "$env:USERPROFILE\\Downloads"
)
foreach ($loc in $locations) {
  $found = Get-ChildItem -Path $loc -Filter "*$name*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) {
    Start-Process $found.FullName
    Write-Output $found.FullName
    exit
  }
}
Write-Error "Not found: $name"
`.trimStart();
  const result = await runPS(script);
  if (!result.trim()) throw new Error(`File "${name}" not found on Desktop, Documents, or Downloads`);
  return `Opened: ${result.trim()}`;
}

module.exports = { openFile };
