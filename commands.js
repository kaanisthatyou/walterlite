// Natural language command parser.
// Returns { type, ...params } or falls back to { type: 'type', text }.

const RULES = [
  // Escape hatch: force-type everything after "type "
  [/^type\s+(.+)$/i,                   m => ({ type: 'type', text: m[1], _explicit: true })],

  // ── Window switching ──────────────────────────────────────────────────────
  [/^claude$|^clu$/i,                  () => ({ type: 'switch', target: 'claude' })],
  [/^obsidian$|^obs$/i,                () => ({ type: 'switch', target: 'obsidian' })],
  [/^gemini$|^gem$/i,                  () => ({ type: 'switch', target: 'gemini' })],
  [/^(?:switch to|go to|focus|show)\s+(.+)$/i, m => ({ type: 'switch', target: m[1].trim().toLowerCase() })],

  // ── Clipboard & editing hotkeys ───────────────────────────────────────────
  [/^copy$/i,            () => ({ type: 'hotkey', combo: 'ctrl+c' })],
  [/^paste$/i,           () => ({ type: 'hotkey', combo: 'ctrl+v' })],
  [/^cut$/i,             () => ({ type: 'hotkey', combo: 'ctrl+x' })],
  [/^undo$/i,            () => ({ type: 'hotkey', combo: 'ctrl+z' })],
  [/^redo$/i,            () => ({ type: 'hotkey', combo: 'ctrl+y' })],
  [/^select all$/i,      () => ({ type: 'hotkey', combo: 'ctrl+a' })],
  [/^save$/i,            () => ({ type: 'hotkey', combo: 'ctrl+s' })],
  [/^save as$/i,         () => ({ type: 'hotkey', combo: 'ctrl+shift+s' })],
  [/^find$/i,            () => ({ type: 'hotkey', combo: 'ctrl+f' })],
  [/^bold$/i,            () => ({ type: 'hotkey', combo: 'ctrl+b' })],
  [/^italic$/i,          () => ({ type: 'hotkey', combo: 'ctrl+i' })],
  [/^underline$/i,       () => ({ type: 'hotkey', combo: 'ctrl+u' })],
  [/^print$/i,           () => ({ type: 'hotkey', combo: 'ctrl+p' })],
  [/^new window$/i,      () => ({ type: 'hotkey', combo: 'ctrl+n' })],
  [/^zoom in$/i,         () => ({ type: 'hotkey', combo: 'ctrl+plus' })],
  [/^zoom out$/i,        () => ({ type: 'hotkey', combo: 'ctrl+minus' })],
  [/^zoom reset$/i,      () => ({ type: 'hotkey', combo: 'ctrl+0' })],

  // ── Browser & tab navigation ──────────────────────────────────────────────
  [/^new tab$/i,         () => ({ type: 'hotkey', combo: 'ctrl+t' })],
  [/^close tab$/i,       () => ({ type: 'hotkey', combo: 'ctrl+w' })],
  [/^reopen tab$/i,      () => ({ type: 'hotkey', combo: 'ctrl+shift+t' })],
  [/^refresh$|^reload$/i, () => ({ type: 'hotkey', combo: 'ctrl+r' })],
  [/^go back$/i,         () => ({ type: 'hotkey', combo: 'alt+left' })],
  [/^go forward$/i,      () => ({ type: 'hotkey', combo: 'alt+right' })],
  [/^address bar$/i,     () => ({ type: 'hotkey', combo: 'ctrl+l' })],
  [/^dev tools$/i,       () => ({ type: 'hotkey', combo: 'f12' })],

  // ── Window management ──────────────────────────────────────────────────────
  [/^close window$/i,    () => ({ type: 'hotkey', combo: 'alt+f4' })],
  // "close/quit/turn off [specific app]" — switches to the app first, then closes
  [/^(?:close|quit|exit|turn off|shut down|kill)\s+(?!(?:this|that|it\b|the\s|window|tab))(.+)$/i,
    m => ({ type: 'system', action: 'close_app', app: m[1].trim() })],
  [/^task manager$/i,    () => ({ type: 'hotkey', combo: 'ctrl+shift+escape' })],
  [/^minimize(?: window)?$/i,  () => ({ type: 'system', action: 'minimize' })],
  [/^(?:maximize|fullscreen|full screen)(?: window)?$/i, () => ({ type: 'system', action: 'maximize' })],
  [/^alt tab$/i,         () => ({ type: 'hotkey', combo: 'alt+tab' })],

  // ── Special single keys ───────────────────────────────────────────────────
  [/^(?:press )?(?:enter|return|new line)$/i, () => ({ type: 'key', key: 'enter' })],
  [/^(?:press )?(?:escape|esc)$/i,            () => ({ type: 'key', key: 'escape' })],
  [/^(?:press )?tab$/i,                       () => ({ type: 'key', key: 'tab' })],
  [/^(?:press )?backspace$/i,                 () => ({ type: 'key', key: 'backspace' })],
  [/^(?:press )?(?:delete|del)$/i,            () => ({ type: 'key', key: 'delete' })],
  [/^(?:press )?(?:up|up arrow)$/i,           () => ({ type: 'key', key: 'up' })],
  [/^(?:press )?(?:down|down arrow)$/i,       () => ({ type: 'key', key: 'down' })],
  [/^(?:press )?(?:left|left arrow)$/i,       () => ({ type: 'key', key: 'left' })],
  [/^(?:press )?(?:right|right arrow)$/i,     () => ({ type: 'key', key: 'right' })],
  [/^(?:press )?home$/i,                      () => ({ type: 'key', key: 'home' })],
  [/^(?:press )?end$/i,                       () => ({ type: 'key', key: 'end' })],
  [/^(?:press )?page ?up$/i,                  () => ({ type: 'key', key: 'pageup' })],
  [/^(?:press )?page ?down$/i,                () => ({ type: 'key', key: 'pagedown' })],
  [/^(?:press )?insert$/i,                    () => ({ type: 'key', key: 'insert' })],
  [/^(?:press )?space$/i,                     () => ({ type: 'key', key: 'space' })],
  [/^(?:press )?f(\d{1,2})$/i,               m => ({ type: 'key', key: `f${m[1]}` })],

  // Explicit combo: "press ctrl c" or "press alt f4"
  [/^press (ctrl|alt|shift|win)\+?[\s](.+)$/i,
    m => ({ type: 'hotkey', combo: `${m[1].toLowerCase()}+${m[2].trim().toLowerCase()}` })],

  // ── System actions ────────────────────────────────────────────────────────
  [/^(?:take (?:a )?)?(?:screenshot|screen ?shot)$/i, () => ({ type: 'system', action: 'screenshot' })],
  [/^volume up$/i,     () => ({ type: 'system', action: 'volume', dir: 'up' })],
  [/^volume down$/i,   () => ({ type: 'system', action: 'volume', dir: 'down' })],
  [/^(?:mute|unmute)$/i, () => ({ type: 'system', action: 'volume', dir: 'mute' })],
  [/^(?:play|pause|play.?pause)$/i, () => ({ type: 'key', key: 'mediaplaypause' })],
  [/^next (?:track|song)$/i, () => ({ type: 'system', action: 'medianext' })],
  [/^prev(?:ious)? (?:track|song)$/i, () => ({ type: 'system', action: 'mediaprev' })],
  [/^lock(?: screen| (?:the )?computer| pc)?$/i, () => ({ type: 'system', action: 'lock' })],
  [/^list (?:windows|apps)$|^show windows$/i,    () => ({ type: 'system', action: 'listwindows' })],
  [/^(?:open|launch|start|run)\s+(.+)$/i,  m => ({ type: 'system', action: 'open', app: m[1].trim() })],

  // ── Turkish system commands ───────────────────────────────────────────────
  [/^sesi? aç$|^sesi? artır$|^sesi? yükselt$|^daha yüksek$/i,   () => ({ type: 'system', action: 'volume', dir: 'up' })],
  [/^sesi? kıs$|^sesi? azalt$|^daha az ses$|^daha alçak$/i,      () => ({ type: 'system', action: 'volume', dir: 'down' })],
  [/^sessiz(?:leştir)?$|^sesi? kapat$|^sessize al$|^sesi? sustur$/i, () => ({ type: 'system', action: 'volume', dir: 'mute' })],
  [/^ekran görüntüsü al$|^ekran al$|^ekran yakala$/i,            () => ({ type: 'system', action: 'screenshot' })],
  [/^kilitle$|^ekranı kilitle$|^bilgisayarı kilitle$/i,           () => ({ type: 'system', action: 'lock' })],
  [/^küçült$|^pencereyi küçült$/i,                               () => ({ type: 'system', action: 'minimize' })],
  [/^büyüt$|^tam ekran$/i,                                       () => ({ type: 'system', action: 'maximize' })],
  [/^pencereyi kapat$|^uygulamayı kapat$/i,                      () => ({ type: 'hotkey', combo: 'alt+f4' })],
  [/^kopyala$/i,       () => ({ type: 'hotkey', combo: 'ctrl+c' })],
  [/^yapıştır$/i,      () => ({ type: 'hotkey', combo: 'ctrl+v' })],
  [/^kes$/i,           () => ({ type: 'hotkey', combo: 'ctrl+x' })],
  [/^geri al$/i,       () => ({ type: 'hotkey', combo: 'ctrl+z' })],
  [/^(?:ileri al|yeniden yap)$/i, () => ({ type: 'hotkey', combo: 'ctrl+y' })],
  [/^kaydet$/i,        () => ({ type: 'hotkey', combo: 'ctrl+s' })],
  [/^(?:hepsini|tümünü) seç$/i, () => ({ type: 'hotkey', combo: 'ctrl+a' })],
  [/^yenile$|^sayfayı yenile$/i, () => ({ type: 'hotkey', combo: 'ctrl+r' })],
  [/^geri git$|^önceki sayfa$/i, () => ({ type: 'hotkey', combo: 'alt+left' })],
  [/^ileri git$|^sonraki sayfa$/i, () => ({ type: 'hotkey', combo: 'alt+right' })],
  [/^yeni sekme$/i,    () => ({ type: 'hotkey', combo: 'ctrl+t' })],
  [/^sekmeyi kapat$/i, () => ({ type: 'hotkey', combo: 'ctrl+w' })],
  [/^(?:sonraki şarkı|sonraki parça|atla|sıradaki)$/i, () => ({ type: 'system', action: 'medianext' })],
  [/^(?:önceki şarkı|önceki parça)$/i,                 () => ({ type: 'system', action: 'mediaprev' })],
  [/^(?:oynat|duraklat|devam et|çal|dur)$/i,           () => ({ type: 'key',    key:   'mediaplaypause' })],

  // ── Mouse ─────────────────────────────────────────────────────────────────
  [/^scroll up(?:\s+(\d+))?$/i,   m => ({ type: 'mouse', action: 'scroll', dir: 'up',   amount: parseInt(m[1] || '3') })],
  [/^scroll down(?:\s+(\d+))?$/i, m => ({ type: 'mouse', action: 'scroll', dir: 'down', amount: parseInt(m[1] || '3') })],
  [/^(?:left.?)?click$/i,        () => ({ type: 'mouse', action: 'click', button: 'left' })],
  [/^right.?click$/i,            () => ({ type: 'mouse', action: 'click', button: 'right' })],
  [/^middle.?click$/i,           () => ({ type: 'mouse', action: 'click', button: 'middle' })],
  [/^double.?click$/i,           () => ({ type: 'mouse', action: 'doubleclick' })],

  // ── AI queries ────────────────────────────────────────────────────────────
  [/^(?:ask\s+)?claude\s+(.+)$/i,
    m => ({ type: 'ai', service: 'claude', mode: 'text',  prompt: m[1].trim() })],
  [/^ask\s+gemini\s+(.+)$/i,
    m => ({ type: 'ai', service: 'gemini', mode: 'text',  prompt: m[1].trim() })],
  [/^(?:generate|create|make|draw)(?:\s+(?:an?|me))?\s+image(?:\s+of)?\s+(.+)$/i,
    m => ({ type: 'ai', service: 'gemini', mode: 'image', prompt: m[1].trim() })],
  [/^image\s+(.+)$/i,
    m => ({ type: 'ai', service: 'gemini', mode: 'image', prompt: m[1].trim() })],
];

function parseCommand(raw) {
  // Groq Whisper often appends a period; strip trailing punctuation before matching
  const text = raw.trim().replace(/[.,!?;:]+$/, '').trim();
  for (const [pattern, resolve] of RULES) {
    const m = text.match(pattern);
    if (m) return resolve(m);
  }
  return { type: 'type', text };
}

module.exports = { parseCommand };
