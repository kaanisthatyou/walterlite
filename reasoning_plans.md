# WALTER — Ultimate Roadmap
**W**orkflow **A**utomation with **L**anguage, **T**asks, **E**xecution, and **R**easoning

Current state: WALTER/lite — voice-to-command pipeline, Telegram bridge, Gemini/Claude browser automation.  
Target state: A persistent, context-aware, multi-modal desktop agent that understands your screen, remembers your habits, and executes complex multi-step tasks from a single natural sentence.

---

## 1. Current Architecture (Baseline)

```
Voice/Text Input
      │
      ▼
[STT — Groq Whisper]
      │
      ▼
[cleanPrompt()]          ← strips filler words
      │
      ▼
[parseCommand()]         ← fast regex layer
      │  (no match)
      ▼
[classifyIntent()]       ← LLM fallback (Groq llama-3.3-70b)
      │
      ▼
[execute() dispatcher]
      │
   ┌──┴──────────────────────────────────┐
   │  type │ hotkey │ mouse │ system │ ai │
   └────────────────────────────────────┘
      │
      ▼
[Telegram reply / Widget status]
```

Weaknesses of the current design:
- No memory of previous commands within a session
- No knowledge of what is on screen
- No awareness of which application is currently active
- Single-turn only — cannot follow up or clarify
- Intent classifier has no feedback loop — wrong classifications silently fail
- STT result is trusted blindly regardless of confidence
- No task chaining — cannot say "do X then Y"
- AI queries go to one hard-coded service with no routing intelligence
- No user-specific personalisation or learning

---

## 2. New Layers — Overview

```
Voice/Text Input
      │
      ▼
[Layer 0]  Hotword Detection          ← always-on, wake word "Walter"
      │
      ▼
[Layer 1]  STT + Confidence Scoring   ← Whisper + confidence threshold + retry
      │
      ▼
[Layer 2]  Context Injection          ← screen state, active app, recent history
      │
      ▼
[Layer 3]  cleanPrompt + NLU          ← filler strip, normalise, spell-correct
      │
      ▼
[Layer 4]  Intent Resolution          ← regex → LLM → vision fallback
      │
      ▼
[Layer 5]  Task Planner               ← multi-step decomposition for complex commands
      │
      ▼
[Layer 6]  Execution Engine           ← dispatcher with undo stack, error recovery
      │
      ▼
[Layer 7]  Response Formatter         ← TTS, Telegram rich messages, widget update
      │
      ▼
[Layer 8]  Memory & Learning          ← command history, user preferences, shortcuts
```

---

## 3. Layer 0 — Always-On Hotword Detection

**Problem:** Currently requires pressing Ctrl+Shift+Space. Hands-free use is impossible.

**Goal:** Say "Hey Walter" and the mic opens automatically — no keyboard needed.

### Implementation

Use a lightweight on-device keyword spotter running in a background thread. The mic is always sampling at low CPU cost; only the full Whisper pipeline fires after the hotword is confirmed.

**Options (ordered by quality/cost):**
| Engine | Size | CPU% idle | Accuracy |
|---|---|---|---|
| `porcupine` (Picovoice) | ~1 MB model | < 1% | Excellent, custom wake word |
| `openWakeWord` (Python) | ~5 MB | ~2% | Good, free, open source |
| `whisper-tiny` looped | ~75 MB | ~5–8% | Acceptable, already installed |

**Recommended**: `openWakeWord` via a Python sidecar process that sends a signal to the Electron main process over a local socket or IPC pipe.

**Configuration:**
```
HOTWORD=walter            # default
HOTWORD_SENSITIVITY=0.5   # 0.0 = never trigger, 1.0 = very sensitive
HOTWORD_ENABLED=true
```

**Flow:**
1. Python sidecar listens on mic continuously at 16kHz, 1-channel
2. Detects "walter" → sends `{ event: 'hotword' }` over localhost:9100
3. Main process receives it → sends `toggle-recording` to renderer
4. Mic opens, Whisper STT runs as normal, hotword audio is discarded
5. After transcription, widget returns to idle

**UX detail:** Flash the widget amber for 300ms when hotword is detected so the user knows it heard them before the mic opens.

---

## 4. Layer 1 — STT Improvement: Confidence + Retry

**Problem:** Whisper's transcription is trusted blindly. Low-quality audio, accents, or background noise produce silently wrong text that fires the wrong command.

**Goal:** Know when a transcription is uncertain and either ask for confirmation or re-record.

### Confidence Scoring

Whisper-large-v3 via Groq returns token-level log probabilities. Average the log-probs to get a rough confidence score (0–1). Below a threshold, trigger a retry or confirmation step.

```javascript
// In stt.js — parse the segment avg_logprob from the Groq response
function transcriptionConfidence(response) {
  const segs = response.segments || [];
  if (!segs.length) return 1.0;
  const avg = segs.reduce((s, seg) => s + (seg.avg_logprob || 0), 0) / segs.length;
  // avg_logprob is typically -0.2 (great) to -1.0+ (poor)
  // Normalise to 0–1
  return Math.min(1, Math.max(0, 1 + avg / 1.5));
}
```

**Thresholds:**
```
confidence >= 0.75  → proceed normally
confidence  0.45–0.74 → proceed but log as uncertain; show yellow in widget
confidence < 0.45   → ask for confirmation via Telegram or re-prompt via widget
```

### Noise Gate

Before sending audio to Whisper, check RMS amplitude. Very quiet recordings are likely silence or mic noise — skip the STT API call entirely.

```javascript
function rmsAmplitude(audioBuffer) {
  const samples = new Int16Array(audioBuffer.buffer);
  const sum = samples.reduce((s, v) => s + v * v, 0);
  return Math.sqrt(sum / samples.length);
}
// Skip if rms < 200 (empirically: below this is ambient noise)
```

### Automatic Retry on Low Confidence

```javascript
if (confidence < 0.45) {
  sendStatus('status', { state: 'error', text: 'unclear — say again' });
  // widget flashes red briefly, mic re-opens automatically after 800ms
  setTimeout(() => mainWindow.webContents.send('toggle-recording'), 800);
  return;
}
```

### Language Hints

Pass the user's preferred language to Whisper so it stops guessing:
```
STT_LANGUAGE=en   # ISO 639-1 code — en, es, fr, pt, de, etc.
```

---

## 5. Layer 2 — Context Injection

**Problem:** Every command is interpreted in a vacuum. "Go back" means nothing without knowing the active application. "Type hello" is dangerous if a spreadsheet formula cell is focused.

**Goal:** Before every intent classification, inject a context snapshot into the prompt so the LLM makes better decisions.

### Context Object

```javascript
// context.js — gathered before every classify call
async function getContext() {
  return {
    activeApp:    await getActiveAppName(),      // e.g. "Firefox", "VS Code", "Excel"
    windowTitle:  await getActiveWindowTitle(),   // e.g. "quarterly_report.xlsx — Excel"
    clipboardText: await readClipboard(),          // last 120 chars
    recentCommands: commandHistory.last(3),        // last 3 executed commands
    timeOfDay:    new Date().toLocaleTimeString(),
    screenText:   null,                           // populated by Layer 2b (vision)
  };
}
```

### Enriched Intent Prompt

The context snapshot is prepended to the LLM's system prompt:

```
ACTIVE APP: Firefox
WINDOW TITLE: "GitHub — Pull requests"
RECENT COMMANDS: scroll_down, scroll_down, copy
CLIPBOARD: "const handleSubmit = async (e) => {"

Given this context, classify the user's command:
```

This dramatically improves ambiguous cases:
- "go back" in Firefox → `go_back` (browser nav), not `undo` (editing)
- "close this" in VS Code → `close_tab` (editor tab), not `close_window`
- "paste" after copying code → `paste` with confidence

### App-Specific Command Sets

Some apps should unlock additional commands that are irrelevant otherwise:

```javascript
const APP_COMMANDS = {
  'firefox':  ['new_tab', 'close_tab', 'go_back', 'go_forward', 'refresh', 'reopen_tab'],
  'vscode':   ['toggle_terminal', 'go_to_definition', 'format_document', 'toggle_sidebar'],
  'spotify':  ['next_track', 'prev_track', 'play_pause', 'volume_up', 'volume_down'],
  'excel':    ['new_sheet', 'save', 'undo', 'redo'],
  'obsidian': ['new_note', 'search_vault', 'toggle_preview'],
};
```

When classifying intent, only the active app's command set is included in the LLM prompt — reducing hallucination and improving accuracy on app-specific phrases.

---

## 6. Layer 2b — Screen Vision (OCR + Vision Model)

**Problem:** Walter is blind. He cannot read text on screen, understand what he's looking at, or make decisions based on visual state.

**Goal:** On demand (or automatically for complex tasks), Walter takes a screenshot and uses a vision model to understand the screen before deciding what to do.

### Two Modes

**Mode A — OCR only (fast, free, local)**  
Use `tesseract.js` (pure JS, no install) to extract all visible text from a screenshot. Takes ~300ms. Good for reading error messages, dialog box text, form labels.

```javascript
const Tesseract = require('tesseract.js');
async function readScreenText(screenshotPath) {
  const { data: { text } } = await Tesseract.recognize(screenshotPath, 'eng');
  return text.trim();
}
```

**Mode B — Vision LLM (slower, powerful)**  
Send the screenshot to a vision-capable model. Currently best options:
- Gemini Flash 1.5 via browser or API (free tier exists)
- Claude claude-sonnet-4-6 with vision via API
- Gemini via the browser automation already in place

```
"Here is a screenshot of my screen. 
 What is currently on screen? Is there an error message? 
 What application is in focus? Describe the UI state in 2 sentences."
```

### When Vision Fires

Vision is expensive (screenshot + inference). It should fire selectively:

| Trigger | Mode |
|---|---|
| User says "what's on screen" / "read this" | B (vision LLM) |
| User says "click the button that says X" | A (OCR) |
| Intent classifier confidence < 0.5 AND active app unknown | A (OCR for context) |
| User sends photo to Telegram | B (vision LLM) |
| Explicit command: "describe the screen" | B (vision LLM) |

### Commands Unlocked by Vision

```
"click the Save button"               → OCR finds "Save", move mouse there, click
"read the error message"              → OCR/vision, reply via Telegram
"what does this form say"             → vision, reply
"fill in my name in the first field"  → OCR finds input, injectText
"close the popup"                     → vision identifies popup, find X button, click
"what tab am I on"                    → OCR reads tab bar, reply
```

---

## 7. Layer 3 Improvements — NLU Preprocessing

### Spell Correction

Whisper occasionally mishears words. A lightweight spell-correction pass before intent classification catches common cases:

```javascript
const corrections = {
  'volum': 'volume',
  'maximise': 'maximize',
  'minimise': 'minimize',
  'wally': 'walter',    // common Whisper mishear of the hotword
  'gemmy': 'gemini',
  'clod': 'claude',
  'clawed': 'claude',
};
```

Use a proper fuzzy-match library (`natural` or `fuse.js`) for corrections beyond a static list.

### Number Normalisation

Whisper returns numbers as words in some locales: "turn volume up by fifty percent" should map the same as "50%". A normalisation pass converts:
```
"fifty" → 50,  "a hundred" → 100,  "twice" → 2,  "a couple" → 2
```

### Command Deduplication Guard

If the same command fires twice within 400ms (double-recognition from a mic bounce), drop the second one silently.

```javascript
let lastCmdKey = '';
let lastCmdTime = 0;
function isDuplicate(cmdKey) {
  const now = Date.now();
  if (cmdKey === lastCmdKey && now - lastCmdTime < 400) return true;
  lastCmdKey = cmdKey; lastCmdTime = now;
  return false;
}
```

---

## 8. Layer 4 Improvements — Intent Resolution

### Confidence Score on Intent

The LLM should return a confidence field alongside the command:

```json
{"cmd": "volume_up", "confidence": 0.92}
{"cmd": "close_window", "confidence": 0.45, "alternatives": ["close_tab"]}
```

Update the system prompt to request this. When confidence < 0.5 and there are alternatives, ask the user:
```
"Did you mean: close window (Alt+F4) or close tab (Ctrl+W)?"
[Telegram inline keyboard with both options]
```

### Intent Feedback Loop

When a command executes and is immediately followed by `undo` or the user says "no, that's wrong" — log the (input → intent) pair as a negative example. Over time, build a local corrections file that overrides the LLM:

```json
// ~/.walter/intent_corrections.json
{
  "close this vs code": "close_tab",
  "go back in the editor": "undo"
}
```

Check this file before calling the LLM. Free, instant, personalised.

### Multi-Intent (Compound Commands)

Allow chaining multiple commands in one sentence:

```
"take a screenshot and send it to telegram"
"open spotify and play"
"close this and switch to chrome"
```

Detection: if the LLM returns `{"cmd":"compound","steps":[...]}`, the Task Planner (Layer 5) takes over. Add to the system prompt:

```
If the user is asking for more than one action in sequence, return:
{"cmd":"compound","steps":["step1_cmd","step2_cmd",...]}
```

---

## 9. Layer 5 — Task Planner (Multi-Step Execution)

**Problem:** Walter can only do one thing per command. Real tasks have steps.

**Goal:** Parse high-level goals into an ordered list of sub-commands and execute them, with the ability to pause, undo, or abort mid-task.

### Architecture

```javascript
// task-planner.js
async function planTask(naturalLanguageGoal, context) {
  const systemPrompt = `
    You are a desktop automation planner.
    The user wants: "${naturalLanguageGoal}"
    Active app: ${context.activeApp}
    
    Break this into a sequence of atomic steps. Use ONLY these step types:
    - hotkey(combo)
    - type(text)
    - click(x, y) or click_on(label)
    - switch(app)
    - system(action)
    - wait(ms)
    - ai_query(service, prompt)
    - confirm(message)   ← pause and ask user before continuing
    
    Return a JSON array of steps. Example:
    [
      {"type":"switch","app":"firefox"},
      {"type":"hotkey","combo":"ctrl+t"},
      {"type":"type","text":"github.com","submit":true},
      {"type":"wait","ms":2000},
      {"type":"confirm","message":"Is the page loaded?"}
    ]
  `;
  // Call LLM (claude CLI or Gemini browser or local Ollama)
  // Parse and return step array
}
```

### Examples

| Voice command | Planned steps |
|---|---|
| "open github and navigate to my repos" | switch(firefox) → hotkey(ctrl+t) → type(github.com/[username]) → wait(2000) |
| "take a screenshot and send it to telegram" | system(screenshot) → telegram_send(photo) |
| "copy this and ask claude to improve it" | hotkey(ctrl+a) → hotkey(ctrl+c) → ai_query(claude, "Improve this text: " + clipboard) |
| "open spotify, play my playlist, then minimize it" | system(open, spotify) → wait(2000) → key(mediaplaypause) → system(minimize) |
| "google the last thing I copied" | read_clipboard → switch(firefox) → hotkey(ctrl+t) → type("google.com/search?q=" + clipboard) |

### Execution with Safety

- Each step is confirmed in the widget before execution (optional, configurable)
- A `confirm` step pauses and sends a Telegram message waiting for "yes" / "no"
- A running plan can be aborted by sending "stop" to Telegram
- All steps that were executed are logged to an undo stack

---

## 10. Layer 6 — Execution Engine Improvements

### Undo Stack

Every executed command pushes an undo action to a stack:

```javascript
const undoStack = [];

function pushUndo(description, undoFn) {
  undoStack.push({ description, undoFn, timestamp: Date.now() });
  if (undoStack.length > 20) undoStack.shift(); // keep last 20
}

// Usage in dispatcher:
case 'hotkey': {
  await sendHotkey(cmd.combo);
  pushUndo(`hotkey ${cmd.combo}`, () => sendHotkey('ctrl+z'));
  break;
}
```

Say "undo" or "undo the last thing" → pops and calls the last undo function.  
Say "undo everything since the screenshot" → walks back to that point.

### Error Recovery

When a command fails, instead of just showing an error, try to recover:

```javascript
try {
  await switchTo(target);
} catch {
  // App not open → try to launch it first
  await openApp(target);
  await sleep(2000);
  await switchTo(target);
}
```

Add recovery logic for common failures:
- Window not found → try launching app
- Input field not focused → try clicking center of screen first
- Hotkey failed → try the menu alternative (e.g. File > Save)

### Rate Limiting

Prevent command flooding (e.g. holding a key accidentally):

```javascript
const rateLimiter = new Map(); // cmd → last execution time
const RATE_LIMITS = {
  'volume': 200,    // ms between calls
  'scroll': 100,
  'hotkey': 150,
  'default': 300,
};
```

---

## 11. Layer 7 — Response Formatting

### Text-to-Speech (TTS) Replies

When Walter executes a command, it can speak the result back through the speakers — no need to look at the Telegram notification.

Options:
- **Windows SAPI** (built-in, free, instant): `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.Speak("Done")`
- **ElevenLabs API** (paid, high quality): for longer AI replies
- **Kokoro TTS** (local, fast, good quality, ~100MB model): best balance

Configuration:
```
TTS_ENABLED=true
TTS_ENGINE=sapi          # sapi | elevenlabs | kokoro
TTS_VOICE=en-US          # locale or voice ID
TTS_MAX_LENGTH=200       # only speak replies shorter than this
```

Short confirmations ("screenshot taken", "volume up", "done") always use SAPI.  
Long AI replies are summarised to 1 sentence before TTS, or skipped.

### Telegram Rich Messages

Replace plain-text replies with structured Telegram messages:

**Inline keyboard for ambiguous intent:**
```
Walter couldn't decide:
[Close Window ✗]  [Close Tab ⊗]
```

**Formatted AI replies** (Markdown in Telegram):
- Code blocks for code responses
- Bold headings for structured answers
- `✓` prefix only for short confirmations, not full AI essays

**Quick action buttons after screenshots:**
```
[Send to Chat]  [Open in Viewer]  [Annotate]
```

### Widget Improvements

The current widget shows a single status line. Expand it with:

- Last 3 commands in a scrollable mini-log
- Active task progress bar (for multi-step tasks)
- Active app indicator (tiny favicon or app icon)
- Mute toggle for TTS
- "Walter is thinking..." animated state during LLM calls
- Clickable command shortcuts (configurable, e.g. screenshot, volume mute)

---

## 12. Layer 8 — Memory and Learning

### Short-Term Memory (Session)

Keep a rolling buffer of the last N commands and their results within a session. Enables:
- "do that again" → repeat last command
- "undo everything since the screenshot" → walk undo stack
- "what did you just do?" → reply with recent history
- Context-aware next command ("now paste it here" after a copy)

```javascript
// memory.js
class SessionMemory {
  constructor(maxSize = 50) {
    this.buffer = [];
    this.maxSize = maxSize;
  }
  add(entry) {
    this.buffer.push({ ...entry, ts: Date.now() });
    if (this.buffer.length > this.maxSize) this.buffer.shift();
  }
  last(n = 1) { return this.buffer.slice(-n); }
  since(label) {
    const idx = this.buffer.findLastIndex(e => e.label === label);
    return idx >= 0 ? this.buffer.slice(idx) : [];
  }
}
```

### Long-Term Memory (Persistent)

Store user patterns to a local JSON file across sessions:

```json
// ~/.walter/memory.json
{
  "aliases": {
    "my notes": "switch obsidian",
    "coding setup": "open vscode then open terminal then maximize"
  },
  "frequentCommands": {
    "screenshot": 47,
    "switch firefox": 23
  },
  "corrections": {
    "close this vs code": "close_tab"
  },
  "preferences": {
    "preferredAI": "gemini",
    "ttsEnabled": true,
    "confirmMultiStep": true
  }
}
```

### Custom Aliases / Macros

Let the user define shortcuts through Telegram:

```
User: "walter, remember: 'work mode' means open vscode, then open terminal, then open firefox"
Walter: "Got it. Say 'work mode' any time to run those three steps."
```

These aliases are stored in `memory.json` and checked before the intent classifier runs.

### Usage Analytics (Local)

Track which commands are used most often, which fail most often, and which always get corrected. Surface this in a weekly Telegram report:

```
📊 WALTER weekly stats:
Most used: screenshot (47×), volume up (31×), switch firefox (23×)
Most failed: "close this" (→ ask which: 8×)
Suggested: Add an alias for your 3-step morning routine
```

---

## 13. New Feature: Multi-AI Router

**Problem:** Different AI services are better for different tasks. Currently every `ask claude` goes to Claude CLI and every `ask gemini` goes to Firefox.

**Goal:** A routing layer that automatically picks the best service for each query type.

### Routing Rules

```javascript
const ROUTER_RULES = [
  { pattern: /code|function|script|debug|error|fix this/i,  service: 'claude',  reason: 'coding tasks' },
  { pattern: /image|picture|draw|generate.*visual/i,        service: 'gemini',  reason: 'image generation' },
  { pattern: /search|latest|news|current|today|stock/i,     service: 'perplexity', reason: 'current events' },
  { pattern: /translate|in (spanish|french|german)/i,       service: 'gemini',  reason: 'translation' },
  { pattern: /math|calculate|solve|equation/i,              service: 'claude',  reason: 'math reasoning' },
];

function routeQuery(prompt) {
  for (const rule of ROUTER_RULES) {
    if (rule.pattern.test(prompt)) return rule.service;
  }
  return process.env.DEFAULT_AI || 'gemini';
}
```

### New AI Services to Add

| Service | Method | Strength |
|---|---|---|
| **Perplexity** | Browser automation (perplexity.ai) | Real-time web search, citations |
| **Claude.ai** | Browser automation (same pattern as Gemini) | Long context, coding, analysis |
| **ChatGPT** | Browser automation (chat.openai.com) | General purpose |
| **Ollama** | Local API (localhost:11434) | Privacy, offline, no cost |
| **Grok** | Browser automation (x.com/grok) | Real-time Twitter/X context |

Each AI service follows the same interface as `gemini-browser.js`:
```javascript
// perplexity-browser.js
module.exports = { query }; // returns { type: 'text'|'image', text?, path? }
```

### Ollama (Local Models)

For total privacy or offline use, Ollama runs local models on your GPU:

```javascript
// ollama.js
async function askOllama(prompt, model = 'llama3.2') {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  const json = await res.json();
  return json.response;
}
```

Recommended models for different tasks:
- `llama3.2:3b` — fast, ~2GB, great for commands
- `mistral:7b` — balanced quality/speed, ~4GB
- `deepseek-coder:6.7b` — code tasks, ~4GB
- `llava:7b` — vision, can describe screenshots

---

## 14. New Feature: File System Commands

**Goal:** Let Walter manage files via voice.

```
"open the downloads folder"
"rename this file to report_final"
"move the screenshot to my desktop"
"find files modified today"
"zip the project folder"
"open the last thing I downloaded"
"delete temp files"
```

Implementation via PowerShell commands already in the ps-utils pattern:

```javascript
// fs-commands.js
async function openFolder(path) { await runPS(`explorer "${path}"`); }
async function findRecent(n = 5) { /* Get-ChildItem ~ -Recurse | Sort LastWriteTime | head n */ }
async function moveFile(src, dest) { await runPS(`Move-Item "${src}" "${dest}"`); }
async function renameFile(path, newName) { await runPS(`Rename-Item "${path}" "${newName}"`); }
async function openLastDownload() {
  const path = await runPS(`(Get-ChildItem ~/Downloads | Sort LastWriteTime -Desc)[0].FullName`);
  await runPS(`Start-Process "${path.trim()}"`);
}
```

Intent patterns to add to `commands.js`:
```javascript
[/^open (?:my )?downloads/i,          () => ({ type: 'fs', action: 'openFolder', path: '%USERPROFILE%\\Downloads' })],
[/^open (?:my )?desktop/i,            () => ({ type: 'fs', action: 'openFolder', path: '%USERPROFILE%\\Desktop' })],
[/^open last download/i,              () => ({ type: 'fs', action: 'openLastDownload' })],
[/^find files? (?:from )?today/i,     () => ({ type: 'fs', action: 'findRecent', days: 1 })],
```

---

## 15. New Feature: Clipboard Manager

**Problem:** Clipboard holds one item. Power users lose copied content constantly.

**Goal:** Walter maintains a clipboard history. Recall any past copy by number or keyword.

```
"show clipboard history"           → Telegram message with last 10 copied items
"paste the second thing I copied"  → sets clipboard to item #2 and pastes
"paste the link I copied earlier"  → semantic search in clipboard history
"clear clipboard history"
```

```javascript
// clipboard.js
const MAX_HISTORY = 50;
let history = [];

function watchClipboard() {
  let last = '';
  setInterval(async () => {
    const current = await readClipboard();
    if (current && current !== last && current.length < 50000) {
      history.unshift({ text: current, ts: Date.now() });
      if (history.length > MAX_HISTORY) history.pop();
      last = current;
    }
  }, 500);
}

function getHistory() { return history; }
function getItem(n) { return history[n - 1]; }
```

---

## 16. New Feature: Scheduled Commands

**Goal:** Say "take a screenshot in 5 minutes" or "remind me at 3pm" or "mute at 11pm every night".

```
"take a screenshot in 5 minutes"
"remind me to call John at 3:30pm"
"mute my computer at 11pm"
"every morning at 9am open my task list"
"in 30 seconds maximize this window"
```

```javascript
// scheduler.js
const schedule = require('node-schedule'); // or use setTimeout for one-shots

function scheduleCommand(cmd, when) {
  if (when instanceof Date || typeof when === 'string') {
    return schedule.scheduleJob(when, () => execute(cmd));
  }
  if (typeof when === 'number') {
    return setTimeout(() => execute(cmd), when);
  }
}

// Natural language time parsing
function parseTime(text) {
  // "in 5 minutes" → Date.now() + 5*60*1000
  // "at 3:30pm"    → today at 15:30
  // "every 9am"    → cron '0 9 * * *'
  // Use chrono-node npm package for robust parsing
  const chrono = require('chrono-node');
  return chrono.parseDate(text);
}
```

List pending jobs via "walter what's scheduled?" → Telegram reply with job list.

---

## 17. New Feature: System Monitoring

**Goal:** Walter can report system health on request or proactively alert on issues.

```
"how's my cpu"
"is my ram okay"
"what's my battery"
"how much disk space do I have"
"alert me if cpu goes above 90%"
```

```javascript
// monitor.js
async function getSystemStats() {
  const cpu = await runPS(`(Get-WmiObject Win32_Processor).LoadPercentage`);
  const ram = await runPS(`
    $os = Get-WmiObject Win32_OperatingSystem
    [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize * 100)
  `);
  const disk = await runPS(`
    $d = Get-PSDrive C
    [math]::Round($d.Used / ($d.Used + $d.Free) * 100)
  `);
  const battery = await runPS(`(Get-WmiObject Win32_Battery).EstimatedChargeRemaining`);
  return { cpu: +cpu, ram: +ram, disk: +disk, battery: +battery };
}
```

Proactive alerts: a background interval checks every 60 seconds. If CPU > 90% for 3 checks in a row → Telegram alert.

---

## 18. New Feature: Telegram Photo/File Input

**Problem:** Walter only receives text and voice from Telegram. You can't send him a photo to analyse or a document to summarise.

**Goal:** Send any file or image to the Telegram bot and Walter processes it.

### Photo → Vision Analysis

```javascript
bot.on('photo', async (ctx) => {
  if (!allowed(ctx)) return;
  const fileId = ctx.message.photo.at(-1).file_id; // largest resolution
  const link   = await ctx.telegram.getFileLink(fileId);
  const tmpPath = path.join(os.tmpdir(), `walter_in_${Date.now()}.jpg`);
  await downloadFile(link.href, tmpPath);
  
  // Send to vision LLM
  const caption = ctx.message.caption || 'What is in this image?';
  const answer = await analyseImageWithVision(tmpPath, caption);
  await ctx.reply(`✓ ${answer}`);
});
```

### Document → Summarise

```javascript
bot.on('document', async (ctx) => {
  const fileName = ctx.message.document.file_name || 'document';
  // Download, detect type (PDF, TXT, DOCX), extract text, summarise via Claude/Gemini
});
```

### Voice Notes (already implemented) + Audio Files

Extend the voice handler to also accept forwarded voice notes and audio files.

---

## 19. New Feature: Conversation Mode

**Problem:** Every interaction is single-turn. You cannot follow up, ask for clarification, or iterate.

**Goal:** A "conversation mode" that maintains a dialogue context with Claude or Gemini across multiple turns.

```
User: "ask gemini to write me a cover letter for a software engineer role"
Gemini: [long response]

User: "make it shorter"              ← follow-up in conversation
User: "add a line about Python"      ← another follow-up
User: "ok looks good, copy it"       ← exit conversation, copy to clipboard
```

```javascript
// conversation.js
class Conversation {
  constructor(service) {
    this.service = service;
    this.history = []; // { role: 'user'|'assistant', content: string }
    this.active = true;
  }

  async send(userMessage) {
    this.history.push({ role: 'user', content: userMessage });
    const response = await queryWithHistory(this.service, this.history);
    this.history.push({ role: 'assistant', content: response });
    return response;
  }

  end() { this.active = false; }
}

let activeConversation = null;
```

Trigger: "start a conversation with gemini" / "let's chat with claude"  
Exit: "end conversation" / "that's enough" / "thanks, exit"  
During conversation mode, the widget shows a distinct `[CONV]` state.

---

## 20. New Feature: Plugin System

**Goal:** Let Walter be extended without modifying core files. Drop a `.js` file into `~/.walter/plugins/` and it's loaded automatically.

### Plugin Interface

```javascript
// Plugin structure
module.exports = {
  name: 'obsidian',
  description: 'Obsidian note-taking integration',
  
  // New intent patterns (added to commands.js at runtime)
  commands: [
    [/^new note (?:about )?(.+)$/i, m => ({ type: 'plugin', plugin: 'obsidian', action: 'new', title: m[1] })],
    [/^search notes? (?:for )?(.+)$/i, m => ({ type: 'plugin', plugin: 'obsidian', action: 'search', query: m[1] })],
  ],

  // New intents for LLM classifier (merged into INTENT_MAP)
  intents: {
    'obsidian_new':    { type: 'plugin', plugin: 'obsidian', action: 'new' },
    'obsidian_search': { type: 'plugin', plugin: 'obsidian', action: 'search' },
  },

  // Executor handler
  async execute(cmd, { notify }) {
    if (cmd.action === 'new') { /* create note */ }
    if (cmd.action === 'search') { /* search vault */ }
  },
};
```

### Plugin Loader

```javascript
// plugin-loader.js
const PLUGIN_DIR = path.join(os.homedir(), '.walter', 'plugins');
function loadPlugins() {
  if (!fs.existsSync(PLUGIN_DIR)) return [];
  return fs.readdirSync(PLUGIN_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => require(path.join(PLUGIN_DIR, f)));
}
```

### Suggested First-Party Plugins

| Plugin | What it adds |
|---|---|
| `obsidian.js` | New note, search vault, open daily note, append to note |
| `spotify.js` | Play artist/song/playlist by name via Spotify Web API |
| `browser-tabs.js` | "switch to the github tab", "close all stackoverflow tabs" |
| `git.js` | Status, commit, push/pull via terminal |
| `notion.js` | Create page, search workspace |
| `weather.js` | "what's the weather" → fetch and reply |
| `timer.js` | Pomodoro timer, countdown, stopwatch |
| `dictionary.js` | "define X", "synonym for X" without opening a browser |

---

## 21. Architecture: Walter Server Mode

**Problem:** Walter runs on one machine. What if you want to control your PC from another device or run Walter headlessly on a server?

**Goal:** Expose Walter as a local HTTP/WebSocket server. Any client (phone browser, tablet, second PC) can send commands.

```javascript
// walter-server.js
const express = require('express');
const app = express();

app.post('/command', async (req, res) => {
  const { text, token } = req.body;
  if (token !== process.env.SERVER_TOKEN) return res.status(403).end();
  const result = await execute(text, { notify: () => {} });
  res.json({ result });
});

// Also serve a minimal mobile web UI at /
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'web-ui', 'index.html')));
app.listen(process.env.SERVER_PORT || 3000);
```

The mobile web UI is a simple HTML page with a text input and voice button — same UX as the widget but in a browser. Accessible via `http://[your-pc-ip]:3000` on your local network.

---

## 22. Implementation Phases

### Phase 2 — Foundation (next)
- [ ] Layer 1: STT confidence scoring + noise gate
- [ ] Layer 2: Context injection (active app + window title)
- [ ] Layer 3: Spell correction + number normalisation
- [ ] Layer 4: Intent confidence + inline keyboard disambiguation
- [ ] Layer 6: Undo stack + error recovery
- [ ] Layer 7: Windows SAPI TTS for short confirmations
- [ ] Long-term memory: aliases + corrections file

### Phase 3 — Intelligence
- [ ] Layer 5: Task planner (multi-step execution)
- [ ] Layer 8: Session memory ("do that again", "undo everything since X")
- [ ] Screen OCR (tesseract.js, triggered on demand)
- [ ] Multi-AI router (auto-pick service by query type)
- [ ] Clipboard manager

### Phase 4 — Expansion
- [ ] Layer 0: Hotword detection (openWakeWord sidecar)
- [ ] Layer 2b: Vision LLM for screen understanding
- [ ] Conversation mode (multi-turn)
- [ ] Telegram photo/document input
- [ ] File system commands
- [ ] Scheduled commands (node-schedule + chrono-node)
- [ ] System monitoring + proactive alerts

### Phase 5 — Ultimate
- [ ] Plugin system + first-party plugins (Obsidian, Spotify, Git)
- [ ] Ollama local model integration
- [ ] Walter Server mode (HTTP + mobile web UI)
- [ ] Perplexity + ChatGPT browser automation
- [ ] TTS upgrade (Kokoro or ElevenLabs)
- [ ] Weekly analytics Telegram report
- [ ] Full screen vision (LLM describes + clicks on elements)

---

## 23. Open Questions / Design Decisions

1. **Hotword privacy**: Always-on mic requires trust. Consider a hardware LED indicator that shows when the mic is live. openWakeWord processes audio entirely locally.

2. **Vision model choice**: Local (Ollama llava) vs remote (Gemini browser). Local is private and free; remote is higher quality. Make it configurable — both code paths should exist.

3. **Task Planner LLM**: The planner needs a capable model (not the intent classifier). Use Claude CLI for planning since it handles complex instructions well. Reserve Gemini for image tasks.

4. **Plugin security**: Plugins run in the same Node process with full system access. A sandboxed `vm2`/`isolated-vm` environment would be safer but limits capability. For now: plugins are first-party only or explicitly trusted.

5. **Conversation history size**: Keep at most 20 turns in memory to avoid token explosion. Older context is summarised ("Earlier you asked about X and got a response about Y").

6. **Multi-device**: If two devices try to send commands at the same time, who wins? Use a message queue (simple in-memory FIFO) — commands are processed in order, never concurrently.

---

## 24. File Structure (Target)

```
walterlite/
├── main.js                  ← Electron entry
├── bot.js                   ← Telegram handler
├── executor.js              ← Command dispatcher
├── commands.js              ← Regex intent rules
├── intent.js                ← LLM intent classifier
├── task-planner.js          ← NEW: multi-step decomposition
├── context.js               ← NEW: screen/app context snapshot
├── memory.js                ← NEW: session + persistent memory
├── conversation.js          ← NEW: multi-turn AI dialogue
├── plugin-loader.js         ← NEW: plugin system
├── scheduler.js             ← NEW: scheduled commands
├── monitor.js               ← NEW: system health
├── clipboard.js             ← NEW: clipboard history
├── ai.js                    ← AI routing (Claude, Gemini, router)
├── ai-router.js             ← NEW: picks service by query type
├── gemini-browser.js        ← Playwright Gemini
├── perplexity-browser.js    ← NEW: Playwright Perplexity
├── ollama.js                ← NEW: local model API
├── claude-cli.js            ← Claude Code CLI
├── stt.js                   ← Groq Whisper STT
├── inject.js                ← Text injection
├── keyboard.js              ← Win32 keyboard
├── mouse.js                 ← Win32 mouse
├── system.js                ← System commands
├── windows.js               ← Window management
├── ps-utils.js              ← PowerShell runner
├── env-utils.js             ← .env read/write
├── vision.js                ← NEW: OCR + vision LLM
├── tts.js                   ← NEW: text-to-speech output
├── walter-server.js         ← NEW: HTTP server mode
├── widget/
│   ├── index.html           ← Widget UI
│   ├── preload.js
│   ├── settings.html        ← Settings UI
│   └── settings-preload.js
└── plugins/                 ← NEW: plugin directory
    ├── obsidian.js
    ├── spotify.js
    └── ...
```

---

*Last updated: 2026-05-14 — WALTER/lite v0.1 baseline*
