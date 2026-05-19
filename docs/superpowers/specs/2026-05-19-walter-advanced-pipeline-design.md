---
title: WALTER Advanced Pipeline Design
date: 2026-05-19
status: approved
---

# WALTER — Advanced Pipeline Design

## Vision

WALTER becomes a fully operational computer control bot — zero hardcoding, any browser, any app, any URL. It understands what is on screen via vision AI, remembers conversation context, and self-corrects when steps fail. All on free-tier AI.

---

## Current Architecture

```
Input (Telegram text/voice / widget / mic hotkey)
  → parseCommand()     regex rules (instant, no LLM)
  → isComplex()        gate: skip intent for rich requests
  → classifyIntent()   Groq LLM → simple command object
  → buildPlan()        Groq LLM → JSON execution_plan[]
  → runPlan()          orchestrator: sequential tool calls with 2-retry + fallback
  → dispatch()         routes to system modules
  → withScreenshot()   wraps result with screen capture → Telegram
```

**Free AI stack:** Groq (LLM + Whisper STT), Claude CLI subprocess, Gemini browser automation.

**Key invariants to preserve:**
- `pasteText` not `injectText` for Unicode/Turkish
- `withScreenshot()` skips responses that already carry `photo` or `text`
- `isComplex()` gate runs before `classifyIntent` — Turkish media/content words must be caught here
- Orchestrator `skip_if` pattern for memory-first plan steps

---

## Sub-project 1 — Browser Foundation

**Goal:** Zero hardcoding. Any browser. Any URL format. Click anywhere (browser DOM + native Windows UI).

### Problem statement
- `10.16.40.250:8000 adresine git` → planner generates `start_session` (wrong — should be `open_url`)
- Firefox executable and profile paths hardcoded in `playwright-session.js`
- Native Windows app elements (dialogs, menus, file pickers) not clickable

### Components

#### `browser-detector.js` (new)
Scans at runtime for installed browsers. No hardcoded paths — reads Windows registry + known install dirs.

```
Priority order: Chrome → Edge → Opera GX → Brave → Firefox
Registry keys checked: HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\
Known dirs: Program Files, Program Files (x86), AppData\Local
Returns: [{ name, executablePath, profileDir, cdpSupport }] sorted by priority
Caches result to memory["apps"]["__browser_ranked_list"]
```

CDP support: Chrome/Edge/Brave/Opera GX all use Chromium CDP. Firefox CDP is less stable — lower priority.

#### `playwright-session.js` (modified)
Replace all hardcoded Firefox references with `browser-detector.js`.

```
acquireContext():
  1. Check memory for cached browser choice
  2. browser-detector.js → pick highest-priority installed browser
  3. Try CDP on port 9222 with that browser
  4. If CDP unavailable: launch with persistent real profile + --remote-debugging-port=9222
  5. Cache chosen browser to memory["apps"]["__active_browser"]
```

Profile detection generalised: each browser has its own profile dir pattern. `browser-detector.js` returns the correct profile path per browser.

#### `tool_browser.js` — URL normalizer (modified)
`normalizeUrl(input)`:
- Bare IP+port (`10.16.40.250:8000`) → `http://10.16.40.250:8000`
- Domain without protocol (`sahibinden.com`) → `https://sahibinden.com`
- Already valid URL → unchanged
- Applied before every `open_url` call and every planner URL resolution

#### `ui-automation.js` (new)
PowerShell UI Automation for native Windows app clicking. No browser required.

```
uiClick(text):
  PowerShell Add-Type: System.Windows.Automation
  Walk automation tree from root
  Find first element where Name or AutomationId contains text (case-insensitive)
  Invoke InvokePattern or SelectionItemPattern
  Returns: element name that was clicked

uiRead(windowTitle):
  Walk automation tree under matching window
  Return all element names + control types
  Used by vision layer to understand native UI without a screenshot
```

New planner tool: `ui_click(text)` — clicks any visible element in any native Windows app by its label.

#### Planner rules (modified)
- Any string matching IP:port, bare domain, or http(s):// → `open_url` always, never `start_session`
- Add `ui_click` to tool list with example: clicking buttons in native dialogs
- Remove `start_session` from all URL-navigation examples

### Data flow
```
User: "10.16.40.250:8000 adresine git"
  → isComplex: false (simple URL nav)
  → classifyIntent: returns open URL intent
  → dispatch → open_url("10.16.40.250:8000")
    → normalizeUrl → "http://10.16.40.250:8000"
    → ensureSession({ url }) → browser-detector picks best browser
    → navigate → screenshot → Telegram
```

---

## Sub-project 2 — Vision Layer

**Goal:** WALTER understands what is on screen using Gemini free vision API. Self-corrects on failure.

**Free API:** Gemini 2.0 Flash (`gemini-2.0-flash`) via `generativelanguage.googleapis.com`. Free tier supports image input. Requires `GEMINI_API_KEY` in `.env` (Google AI Studio, no credit card).

### Components

#### `ai.js` — `askGeminiVision(prompt, imagePath)` (new function)
```
Reads imagePath → base64 encodes
POST to Gemini API with inline image part
Returns text response
Falls back gracefully if GEMINI_API_KEY not set (returns null with warning)
```

#### `tools/tool_vision.js` (new)

`analyze_screen(question)`:
```
captureScreen() → tmpPath
askGeminiVision(question, tmpPath)
Returns: Gemini's text answer about what is on screen
Example: analyze_screen("what buttons are visible?") → "I can see: Save, Cancel, Apply"
```

`vision_click(description)`:
```
captureScreen() → tmpPath
askGeminiVision(
  "Return ONLY JSON: {x: number, y: number} for the element matching: " + description +
  ". Coordinates as percentage of screen width/height (0-100).",
  tmpPath
)
Parse JSON → scale to screen resolution → mouseMove + mouseClick
Records step to session buffer if session active
```

#### `orchestrator.js` — vision-guided retry (modified)
When a step fails after 2 retries and no static fallback exists:
```
screenshot → analyze_screen("Step '[step.tool]' failed. What is on screen? Is there an error?")
Inject vision result into error message
Log to console (user sees it in Telegram error reply)
Do NOT auto-retry with vision in Sub-project 2 — that is Sub-project 4's job
```

#### Planner tools added
- `analyze_screen(question)` — described in tool list, with example
- `vision_click(description)` — for when DOM element finding fails

### Data flow
```
User: "kaydet butonuna tıkla"
  → session_step → findElement (DOM strategies) → fails
  → vision_click("Kaydet button") 
    → screenshot → Gemini → {x: 45, y: 23}
    → scale to pixels → mouseClick
    → screenshot → Telegram
```

---

## Sub-project 3 — Conversation Context

**Goal:** Stateful multi-turn commands. "Click that", "do it again", "go back" all resolve correctly.

### Components

#### `bot.js` — conversation buffer (modified)
```javascript
const conversationHistory = []; // max 10 entries
// Each entry: { role: "user"|"assistant", content: string, timestamp }
// After each exchange: push both sides, trim to last 10
```

#### `planner.js` — context injection (modified)
History injected as additional messages before the user's current message:
```
[system prompt]
[history[0]] user: ...
[history[0]] assistant: ...
...
[history[N]] user: ...
[current] user: <current command>
```

This uses Groq's multi-turn message format — no prompt engineering needed, the model handles "that", "it", "again" naturally.

#### Current page context (modified)
`getPageContext()` result (URL + title + visible text excerpt) always prepended to the user message when a session is active:
```
[Page: http://10.16.40.250:8000/login | Title: HBYS Login]
User command: "kullanıcı adı alanına admin yaz"
```

---

## Sub-project 4 — Autonomous Self-Correction

**Goal:** WALTER evaluates its own output and retries without user prompting.

### Components

#### `orchestrator.js` — verify-and-retry loop (modified)
After every step that produces a screenshot:
```
result = await toolFn(params)
if result has photo:
  verdict = await analyze_screen("Did '" + step.reason + "' succeed? Answer YES or NO then briefly explain.")
  if verdict starts with NO:
    retry with vision context injected into next attempt (max 3 total)
    if still failing after 3: throw with Gemini's explanation as error message
```

#### `tools/tool_vision.js` — `verify_step(expected)` (new)
```
captureScreen()
askGeminiVision("Is this visible on screen: '" + expected + "'? Answer YES or NO.", screenshot)
Returns: { success: boolean, detail: string }
```

#### Planner support
New plan pattern supported:
```json
{ "tool": "verify_step", "parameters": { "expected": "login form is visible" } }
```

---

## Sub-project 5 — AI Pipeline Optimization

**Goal:** Right model for the right task. Parallel steps. Smarter planning.

### Components

#### `ai-router.js` (new)
```
route(taskType):
  "vision"    → Gemini API (free, supports images)
  "fast"      → Groq llama-3.1-8b-instant (fastest, simple commands)
  "reasoning" → Groq llama-3.3-70b-versatile (current default, complex plans)
  "knowledge" → Claude CLI (best reasoning, no API key needed if Claude Code installed)
```

#### `orchestrator.js` — parallel execution (modified)
Steps with no `{{context.*}}` dependency on each other run in `Promise.all()`.
Dependency graph built from `store_as` / parameter references before execution.

#### `planner.js` — confidence + clarification (modified)
If plan intent is `unclear` or execution_plan is empty:
- Instead of silently returning null, send user a clarifying question via `notify`
- Example: "Bunu tam anlayamadım — hangi uygulamayı kastettin?"

---

## Configuration Reference

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `ALLOWED_USER_ID` | Yes | Your Telegram numeric ID |
| `GROQ_API_KEY` | Yes | Groq API key (free at groq.com) |
| `GEMINI_API_KEY` | Sub-project 2+ | Google AI Studio key (free, no CC) |
| `VOICE_HOTKEY` | No | Default: Ctrl+Shift+Space |

---

## Build Order

| # | Sub-project | Depends on | Complexity |
|---|---|---|---|
| 1 | Browser Foundation | nothing | Medium |
| 2 | Vision Layer | 1 (screen capture) | Medium |
| 3 | Conversation Context | nothing | Low |
| 4 | Autonomous Self-Correction | 2 | Medium |
| 5 | AI Pipeline Optimization | 1–4 | Low–Medium |

Sub-projects 1 and 3 can be built in parallel — they have no shared dependencies.
