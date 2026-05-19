const { runPS } = require('./ps-utils');

// Clicks any visible native Windows UI element by its visible label text.
// Uses System.Windows.Automation — works in dialogs, menus, file pickers, any Win32 app.
async function uiClick(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const script = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
$target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$root   = [System.Windows.Automation.AutomationElement]::RootElement
$cond   = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  $target,
  [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase
)
# Search foreground window first, fall back to full desktop
$fg  = $null
try {
  $hWnd  = (Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' -Name FG -Namespace W -PassThru)::GetForegroundWindow()
  $fg    = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)
} catch {}
$el = if ($fg) { $fg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond) } else { $null }
if (-not $el) { $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond) }
if (-not $el) { throw "UI element not found: $target" }

# Try InvokePattern first (buttons, menu items)
try {
  $inv = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $inv.Invoke()
  Write-Output "Invoked: $($el.Current.Name)"
} catch {
  # Fall back to mouse click at element center
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class UIAC {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x02, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x04, 0, 0, 0, UIntPtr.Zero);
  }
}
'@ -ErrorAction SilentlyContinue
  $r = $el.Current.BoundingRectangle
  [UIAC]::Click([int]($r.X + $r.Width/2), [int]($r.Y + $r.Height/2))
  Write-Output "Clicked: $($el.Current.Name)"
}`.trimStart();
  return runPS(script);
}

// Lists all visible interactive elements in a window (or foreground if no title given).
// Call this before ui_click to see what element names are available.
async function uiRead(windowTitle) {
  const scope = (windowTitle && windowTitle.trim())
    ? `$titleCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(windowTitle || '', 'utf8').toString('base64')}')),
  [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase
)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $titleCond)
if (-not $win) { $win = $root }`
    : '$win = $root';

  const script = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
$root = [System.Windows.Automation.AutomationElement]::RootElement
${scope}
$els = $win.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)
$out = @()
foreach ($el in $els) {
  $name = $el.Current.Name
  $type = $el.Current.LocalizedControlType
  $rect = $el.Current.BoundingRectangle
  if ($name -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
    $out += "[$type] $name"
  }
}
($out | Select-Object -Unique | Select-Object -First 40) -join [Environment]::NewLine`.trimStart();
  return runPS(script);
}

module.exports = { uiClick, uiRead };
