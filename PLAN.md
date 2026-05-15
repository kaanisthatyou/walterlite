# WALTER/lite — Feature Roadmap & Architecture

## What This App Is

WALTER/lite is a **voice-and-text computer controller** — a tiny always-on-top Electron widget that
lets you operate Windows using natural language, from your phone via Telegram or directly from your
keyboard with a local microphone hotkey.

You speak or type a command. The app understands it. Your computer does it.

---

## Architecture (current)

```
Input Sources
  ├── Telegram text message  ─────────────────────────────┐
  ├── Telegram voice note → Groq Whisper (transcribe) ──┐ │
  └── Local mic hotkey (Ctrl+Shift+Space) → Groq Whisper┘ │
                                                           │
                       commands.js (parseCommand)  ←───────┘
                                  │
                        executor.js (execute)
                   ┌──────────────┼──────────────────┐
              inject.js      keyboard.js         mouse.js
           (type text)    (shortcuts/keys)   (click/scroll)
                                 │
                             system.js
                (lock, volume, screenshot, open app)
                                 │
                           windows.js
                     (switch & focus windows)
                                 │
                   Status → Electron widget (always-on-top)
```

---

## Phase 1 — Command System (implemented)

### New modules added

| File | Purpose |
|------|---------|
| `commands.js` | Natural language → structured command object |
| `keyboard.js` | Win32 SendInput for keyboard shortcuts |
| `mouse.js`    | Win32 mouse_event for click/scroll/move |
| `system.js`   | Lock, volume, screenshot, app open/close |
| `executor.js` | Central dispatcher routing to the above |
| `ps-utils.js` | Shared PowerShell runner (hidden window, encoded) |

### Full command reference

**Window switching**
```
claude / obsidian / gemini
switch to [app]  /  go to chrome  /  go to vscode
```

**Editing & clipboard**
```
copy / paste / cut / undo / redo / select all
save / save as / find / print / bold / italic / underline
new window / zoom in / zoom out / zoom reset
```

**Browser / tabs**
```
new tab / close tab / reopen tab / refresh / reload
go back / go forward / address bar / dev tools
```

**Keys**
```
enter / escape / tab / backspace / delete
up / down / left / right / home / end / page up / page down
press f5  /  press ctrl shift p  (arbitrary combos)
```

**Mouse**
```
click / right click / double click / middle click
scroll up [n] / scroll down [n]
```

**System**
```
screenshot                → Win+Shift+S (Snipping Tool)
volume up / down / mute
play / pause / next track / prev track
lock / lock screen
minimize / maximize
list windows
open notepad / chrome / spotify / etc.
```

**Escape hatch**
```
type [any text]           → bypass command parser, always type
```

### Local microphone hotkey

Press **Ctrl+Shift+Space** (configurable via `VOICE_HOTKEY` in .env) to toggle recording.
The MIC button in the widget does the same. Audio is transcribed via Groq Whisper and routed
through the command parser. Local voice does NOT auto-press Enter (safe for mid-sentence dictation).

### Settings panel

Settings now includes a **Groq API Key** field — no manual .env editing needed.

---

## Phase 2 — Smarter Language (planned)

- Fuzzy matching: "take a photo of the screen" → screenshot
- LLM intent layer: pipe ambiguous voice through Claude Haiku for classification
- Multi-step sequences: "copy that and paste it in obsidian" → Ctrl+C, switch, Ctrl+V
- Contextual window memory: "go back to what I had before"
- Safety confirmation for destructive commands

---

## Phase 3 — Macro / Script Engine (planned)

- Record macros: "start recording macro [name]" → captures commands
- Play macros: "run macro daily routine"
- Loops: "press down 5 times", "scroll down 3 times"
- Storage: macros.json, shareable
- Import / export macro files

---

## Phase 4 — Screen Awareness (planned)

- Screenshot + OCR: "what does the screen say" → extracts text, replies via Telegram
- Color picker: "what color is at cursor"
- Window list with titles → tappable Telegram inline keyboard
- "Click the Save button" → vision model locates button on screen

---

## Phase 5 — App-Specific Integrations (planned)

**VS Code**: open file, run build task, toggle terminal, git commit
**Obsidian**: new note, append to daily note, search vault
**Browser**: click by link text, fill form fields, read page text
**Spotify**: search and play (via search UI keyboard shortcut)

---

## Phase 6 — Remote / Multi-device (planned)

- Multiple Telegram users with different permission levels
- Command history as Telegram inline keyboard
- Remote PC: reverse SSH tunnel mode
- Status push: bot messages you when long tasks finish

---

## Phase 7 — AI Agent Mode (planned)

- "Do this for me" → Claude plans steps, WALTER executes
- Screen-aware agent: screenshot → vision model → decide → act
- "Write a function that does X and type it into VS Code"
- Form-filling agent: Claude reads fields from OCR, fills intelligently

---

## Configuration Reference

| Variable | Required | Default | Description |
|---------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram only | — | Bot token from @BotFather |
| `ALLOWED_USER_ID` | Telegram only | — | Your Telegram numeric ID |
| `GROQ_API_KEY` | Voice features | — | Groq API key (free at groq.com) |
| `CLAUDE_PROCESS` | No | `Claude` | Process name for Claude window |
| `OBSIDIAN_PROCESS` | No | `Obsidian` | Process name for Obsidian |
| `FIREFOX_PROCESS` | No | `firefox` | Browser for Gemini |
| `VOICE_HOTKEY` | No | `CommandOrControl+Shift+Space` | Global mic hotkey |

## Running

```
npm start
```

Widget appears bottom-right. Telegram bot starts automatically if credentials are set.
Local voice works immediately once Groq key is saved via Settings.
