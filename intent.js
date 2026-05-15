// LLM intent classifier — fires only when the regex parser finds no match.
//
// Provider is auto-detected from INTENT_MODEL:
//   model contains "/"  (e.g. "anthropic/claude-3-haiku")  → OpenRouter
//   model has no "/"    (e.g. "llama-3.3-70b-versatile")    → Groq
//   INTENT_BASE_URL set explicitly                          → use that
//
// Recommended models (set in .env or Settings):
//   Groq free     : llama-3.3-70b-versatile   (big upgrade from 8B, still free)
//   OpenRouter free: google/gemini-flash-1.5:free  meta-llama/llama-3.1-70b-instruct:free
//   OpenRouter paid: anthropic/claude-3-haiku  openai/gpt-4o-mini  google/gemini-1.5-flash

const { OpenAI } = require('openai');

let client;

function getBaseURL() {
  if (process.env.INTENT_BASE_URL) return process.env.INTENT_BASE_URL;
  const model = process.env.INTENT_MODEL || '';
  // OpenRouter models always use "provider/model" format with a slash
  if (model.includes('/')) return 'https://openrouter.ai/api/v1';
  return 'https://api.groq.com/openai/v1';
}

function getApiKey() {
  return process.env.INTENT_API_KEY || process.env.GROQ_API_KEY || '';
}

function getModel() {
  return process.env.INTENT_MODEL || 'llama-3.3-70b-versatile'; // free on Groq, ~2.5x better than 8B
}

function buildClient() {
  const baseURL = getBaseURL();
  const extraHeaders = baseURL.includes('openrouter')
    ? { 'HTTP-Referer': 'https://walterlite', 'X-Title': 'WALTER/lite' }
    : {};
  return new OpenAI({ apiKey: getApiKey(), baseURL, defaultHeaders: extraHeaders });
}

function getClient() {
  if (!client) client = buildClient();
  return client;
}

function resetClient() { client = null; }

// Every recognised intent maps to the same command-object shape as parseCommand.
const INTENT_MAP = {
  volume_up:       { type: 'system', action: 'volume',      dir: 'up' },
  volume_down:     { type: 'system', action: 'volume',      dir: 'down' },
  volume_mute:     { type: 'system', action: 'volume',      dir: 'mute' },
  next_track:      { type: 'system', action: 'medianext' },
  prev_track:      { type: 'system', action: 'mediaprev' },
  play_pause:      { type: 'key',    key:    'mediaplaypause' },
  screenshot:      { type: 'system', action: 'screenshot' },
  lock:            { type: 'system', action: 'lock' },
  minimize:        { type: 'system', action: 'minimize' },
  maximize:        { type: 'system', action: 'maximize' },
  close_window:    { type: 'hotkey', combo:  'alt+f4' },
  copy:            { type: 'hotkey', combo:  'ctrl+c' },
  paste:           { type: 'hotkey', combo:  'ctrl+v' },
  cut:             { type: 'hotkey', combo:  'ctrl+x' },
  undo:            { type: 'hotkey', combo:  'ctrl+z' },
  redo:            { type: 'hotkey', combo:  'ctrl+y' },
  save:            { type: 'hotkey', combo:  'ctrl+s' },
  find:            { type: 'hotkey', combo:  'ctrl+f' },
  select_all:      { type: 'hotkey', combo:  'ctrl+a' },
  bold:            { type: 'hotkey', combo:  'ctrl+b' },
  italic:          { type: 'hotkey', combo:  'ctrl+i' },
  zoom_in:         { type: 'hotkey', combo:  'ctrl+plus' },
  zoom_out:        { type: 'hotkey', combo:  'ctrl+minus' },
  new_tab:         { type: 'hotkey', combo:  'ctrl+t' },
  close_tab:       { type: 'hotkey', combo:  'ctrl+w' },
  reopen_tab:      { type: 'hotkey', combo:  'ctrl+shift+t' },
  refresh:         { type: 'hotkey', combo:  'ctrl+r' },
  go_back:         { type: 'hotkey', combo:  'alt+left' },
  go_forward:      { type: 'hotkey', combo:  'alt+right' },
  scroll_up:       { type: 'mouse',  action: 'scroll', dir: 'up',   amount: 3 },
  scroll_down:     { type: 'mouse',  action: 'scroll', dir: 'down', amount: 3 },
  click:           { type: 'mouse',  action: 'click',  button: 'left' },
  right_click:     { type: 'mouse',  action: 'click',  button: 'right' },
  double_click:    { type: 'mouse',  action: 'doubleclick' },
  press_enter:     { type: 'key',    key: 'enter' },
  press_escape:    { type: 'key',    key: 'escape' },
  press_tab:       { type: 'key',    key: 'tab' },
  press_backspace: { type: 'key',    key: 'backspace' },
  press_delete:    { type: 'key',    key: 'delete' },
};

const SYSTEM_PROMPT = `You are a voice command classifier for a Windows desktop automation app.
Map the user's speech to one command name and return ONLY a JSON object. No explanation.
The user may speak Turkish. Turkish equivalents are listed alongside English ones.

COMMANDS (name: triggers / examples):
volume_up: louder, turn it up, increase volume | sesi aç, sesi artır, sesi yükselt, daha yüksek
volume_down: quieter, turn it down, lower the volume | sesi kıs, sesi azalt, daha alçak
volume_mute: mute, silence, unmute | sessiz, sessize al, sesi kapat, sesi sustur
screenshot: take a screenshot, capture the screen | ekran görüntüsü al, ekran al, ekran yakala
lock: lock the computer, lock screen | kilitle, ekranı kilitle, bilgisayarı kilitle
minimize: minimize, hide this window | küçült, pencereyi küçült
maximize: maximize, fullscreen | büyüt, tam ekran
close_window: close this, close the window, close the app, shut this, exit this, kill this
copy: copy that, copy the text | kopyala
paste: paste, paste it here | yapıştır
cut: cut that | kes
undo: undo, undo that, revert | geri al
redo: redo, redo that | ileri al, yeniden yap
save: save, save the file | kaydet
find: find, search in page | bul, sayfada ara
select_all: select all | hepsini seç, tümünü seç
bold: bold, make it bold | kalın yap
italic: italic, make it italic | italik yap
zoom_in: zoom in | yakınlaştır
zoom_out: zoom out | uzaklaştır
new_tab: new tab | yeni sekme
close_tab: close tab | sekmeyi kapat
reopen_tab: reopen tab, restore tab
refresh: refresh, reload | yenile, sayfayı yenile
go_back: go back (browser navigation), previous page | geri git, önceki sayfa
go_forward: go forward, next page | ileri git
scroll_up: scroll up, go up | yukarı kaydır, yukarı git
scroll_down: scroll down, go down | aşağı kaydır, aşağı git
click: click, left click, tap | tıkla
right_click: right click, context menu | sağ tıkla
double_click: double click, open this | çift tıkla
press_enter: press enter, confirm, submit | enter'a bas, onayla, gönder
press_escape: press escape, cancel, dismiss | escape, iptal
press_tab: press tab, next field | tab'a bas
press_backspace: backspace, delete last character
press_delete: delete, press delete
next_track: next song, next track, skip | sonraki şarkı, sonraki parça, atla
prev_track: previous song, previous track | önceki şarkı, önceki parça
play_pause: play, pause, play/pause | oynat, duraklat, çal, dur
switch: focus a running app — ONLY "switch to X" / "go to X" / Turkish "X'e geç" with no extra intent (include "target" field)
open: launch an INSTALLED APP — ONLY short single app names like "spotify", "notepad", "chrome", "calculator", "discord". Turkish: "X aç" where X is just an app name. NEVER sentences, file names, paths, or anything with more than 3 words. If unsure → type.
close_window: close whatever is currently focused — "close this", "close the window", "exit this", "kill this" (no specific app name mentioned)
close_app: close a SPECIFIC named app — "close calculator", "quit spotify", "turn off notepad", "kill discord" — include "target" field with the app name
type: ← ONLY if it's genuinely text to type, not a command

ask_claude: ask claude, what does claude think, have claude answer, claude tell me, claude explain — include "prompt" field with the exact question
ask_gemini: ask gemini, what does gemini say, have gemini answer, gemini tell me, gemini explain — include "prompt" field
generate_image: generate an image, create a picture, draw something, make an image, image of — include "prompt" field with the image description

RESPONSE FORMAT — return ONLY valid JSON:
{"cmd":"volume_up"}
{"cmd":"switch","target":"chrome"}
{"cmd":"open","app":"notepad"}
{"cmd":"ask_claude","prompt":"what is the capital of France"}
{"cmd":"ask_gemini","prompt":"explain quantum computing simply"}
{"cmd":"generate_image","prompt":"a sunset over mountains"}
{"cmd":"type"}

RULES:
- Ignore numbers like "by 10", "50%", "a little" — map to the intent (volume_up stays volume_up).
- "close this/that/it/the window" → close_window.
- "go back" defaults to go_back (browser) unless clearly editing → undo.
- "play X on YouTube/Spotify/etc." or "watch X on Y" or "search for X" or Turkish equivalents ("youtube'dan X aç", "X'i çal") → {"cmd":"type"}.
- "close X", "quit X", "X'i kapat", "X'ı kapat" where X is a specific app name → close_app with "target" field.
- Any sentence mentioning a file, document, folder, or path → {"cmd":"type"}.
- Turkish IS supported — use the Turkish equivalents listed above. Do NOT return type just because the input is Turkish.
- If the request contains a platform name (youtube, spotify) AND content (song, video, artist name) → {"cmd":"type"} — the planner handles those.
- If it's a complex multi-step request, genuinely text to type, or you're unsure → {"cmd":"type"}.
- Return ONLY the JSON. Nothing else.`;

async function classifyIntent(text) {
  const key = getApiKey();
  if (!key) return null;

  try {
    const res = await getClient().chat.completions.create({
      model: getModel(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: text },
      ],
      max_tokens: 64,
      temperature: 0,
    });

    const raw = res.choices[0]?.message?.content?.trim() || '';
    const m   = raw.match(/\{[^}]+\}/);
    if (!m) return null;

    const json = JSON.parse(m[0]);
    if (!json.cmd || json.cmd === 'type') return null;

    if (json.cmd === 'switch')         return json.target ? { type: 'switch', target: String(json.target).toLowerCase() } : null;
    if (json.cmd === 'open')           return json.app    ? { type: 'system', action: 'open', app: String(json.app) }          : null;
    if (json.cmd === 'close_app')      return json.target ? { type: 'system', action: 'close_app', app: String(json.target).toLowerCase() } : null;
    if (json.cmd === 'ask_claude')     return json.prompt ? { type: 'ai', service: 'claude', mode: 'text',  prompt: String(json.prompt) } : null;
    if (json.cmd === 'ask_gemini')     return json.prompt ? { type: 'ai', service: 'gemini', mode: 'text',  prompt: String(json.prompt) } : null;
    if (json.cmd === 'generate_image') return json.prompt ? { type: 'ai', service: 'gemini', mode: 'image', prompt: String(json.prompt) } : null;

    return INTENT_MAP[json.cmd] || null;
  } catch {
    return null;
  }
}

module.exports = { classifyIntent, resetClient };
