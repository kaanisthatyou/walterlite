const { runPS } = require('./ps-utils');

// Windows virtual key codes
const VK = {
  // Control flow
  enter: 0x0D, return: 0x0D,
  escape: 0x1B, esc: 0x1B,
  tab: 0x09,
  backspace: 0x08,
  delete: 0x2E, del: 0x2E,
  insert: 0x2D,
  space: 0x20,
  // Arrow / navigation
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22,
  // Function keys
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73,
  f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77,
  f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
  // Modifiers
  ctrl: 0x11, lctrl: 0xA2, rctrl: 0xA3,
  alt: 0x12,  lalt:  0xA4,
  shift: 0x10, lshift: 0xA0,
  win: 0x5B,  lwin: 0x5B,
  // OEM / misc
  plus: 0xBB, minus: 0xBD, period: 0xBE, comma: 0xBC,
  '0': 0x30,
  printscreen: 0x2C,
  // Media / volume
  volumemute: 0xAD, volumedown: 0xAE, volumeup: 0xAF,
  medianext: 0xB0, mediaprev: 0xB1, mediastop: 0xB2, mediaplaypause: 0xB3,
  // Letters (A–Z)
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45,
  f: 0x46, g: 0x47, h: 0x48, i: 0x49, j: 0x4A,
  k: 0x4B, l: 0x4C, m: 0x4D, n: 0x4E, o: 0x4F,
  p: 0x50, q: 0x51, r: 0x52, s: 0x53, t: 0x54,
  u: 0x55, v: 0x56, w: 0x57, x: 0x58, y: 0x59,
  z: 0x5A,
  // Digits 1–9
  '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34, '5': 0x35,
  '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
};

// C# inline type — compiled once per PS process, -ErrorAction SilentlyContinue ignores redef errors
const CS_DEF = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class KB {
  [StructLayout(LayoutKind.Explicit, Size=40)]
  struct I { [FieldOffset(0)] public uint t; [FieldOffset(8)] public ushort vk; [FieldOffset(10)] public ushort sc; [FieldOffset(12)] public uint fl; [FieldOffset(16)] public uint time; [FieldOffset(24)] public IntPtr ex; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, I[] a, int s);
  static void S(ushort vk, uint fl) { var a=new I[1]; a[0].t=1; a[0].vk=vk; a[0].fl=fl; SendInput(1,a,40); }
  public static void Down(ushort vk) { S(vk, 0); }
  public static void Up(ushort vk)   { S(vk, 2); }
  public static void Tap(ushort vk)  { Down(vk); Up(vk); }
}
'@ -ErrorAction SilentlyContinue`;

function hex(n) { return '0x' + n.toString(16).toUpperCase().padStart(2, '0'); }

async function sendHotkey(combo) {
  const parts  = combo.toLowerCase().split('+').map(s => s.trim());
  const key    = parts.pop();
  const mods   = parts;

  const keyVK = VK[key];
  if (!keyVK) throw new Error(`Unknown key: "${key}" (combo: "${combo}")`);

  const modVKs = mods.map(m => {
    const vk = VK[m];
    if (!vk) throw new Error(`Unknown modifier: "${m}" (combo: "${combo}")`);
    return vk;
  });

  const lines = [CS_DEF];
  for (const vk of modVKs)                 lines.push(`[KB]::Down(${hex(vk)})`);
  lines.push(`[KB]::Tap(${hex(keyVK)})`);
  for (const vk of [...modVKs].reverse())  lines.push(`[KB]::Up(${hex(vk)})`);

  return runPS(lines.join('\n'));
}

async function pressKey(key) {
  const vk = VK[key.toLowerCase()];
  if (!vk) throw new Error(`Unknown key: "${key}"`);
  return runPS(`${CS_DEF}\n[KB]::Tap(${hex(vk)})`);
}

module.exports = { sendHotkey, pressKey, VK };
