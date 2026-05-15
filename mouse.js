const { runPS } = require('./ps-utils');

const CS_DEF = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class MX {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int ex);
  public const uint LD=0x2,LU=0x4,RD=0x8,RU=0x10,MD=0x20,MU=0x40,WHL=0x800;
  public static void LClick()  { mouse_event(LD,0,0,0,0); mouse_event(LU,0,0,0,0); }
  public static void RClick()  { mouse_event(RD,0,0,0,0); mouse_event(RU,0,0,0,0); }
  public static void MClick()  { mouse_event(MD,0,0,0,0); mouse_event(MU,0,0,0,0); }
  public static void DblClick(){ LClick(); LClick(); }
  public static void Scroll(int delta) { mouse_event(WHL,0,0,(uint)(delta*120),0); }
  public static void Move(int x, int y){ SetCursorPos(x, y); }
}
'@ -ErrorAction SilentlyContinue`;

async function mouseClick(button = 'left') {
  const fn = { left: 'LClick', right: 'RClick', middle: 'MClick' }[button] || 'LClick';
  return runPS(`${CS_DEF}\n[MX]::${fn}()`);
}

async function mouseDoubleClick() {
  return runPS(`${CS_DEF}\n[MX]::DblClick()`);
}

async function mouseScroll(direction, amount = 3) {
  const delta = direction === 'down' ? -amount : amount;
  return runPS(`${CS_DEF}\n[MX]::Scroll(${delta})`);
}

async function mouseMove(x, y) {
  return runPS(`${CS_DEF}\n[MX]::Move(${Math.round(x)}, ${Math.round(y)})`);
}

module.exports = { mouseClick, mouseDoubleClick, mouseScroll, mouseMove };
