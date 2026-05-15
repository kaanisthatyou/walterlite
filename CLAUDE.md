# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```bash
npm start          # electron .
```

No build step, no tests, no lint config. The app hot-reloads JS changes because Electron re-requires modules on each command execution (modules are not cached between IPC calls in the way a web server would be).

`.env` file in the root holds all secrets. Edited live via the Settings UI (env-utils.js reads/writes it).

Required env vars: `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_ID`, `GROQ_API_KEY`.  
Optional: `INTENT_API_KEY`, `INTENT_MODEL`, `VOICE_HOTKEY`, `FIREFOX_PATH`, `CLAUDE_PROCESS`, `OBSIDIAN_PROCESS`, `CLAUDE_PREPROMPT`, `GEMINI_PREPROMPT`.

---

## Architecture

WALTER is an **Electron desktop app** that accepts commands via Telegram (text/voice) and a floating widget. Every command flows through a three-tier routing pipeline before reaching a dispatcher.

### Entry Points

- **`main.js`** — Electron main process. Creates the always-on-top frameless widget window, registers the global voice hotkey (`Ctrl+Shift+Space`), starts the Telegram bot, and handles IPC from the widget.
- **`bot.js`** — Telegraf bot. Text and voice messages both funnel into `execute()`. Voice is first transcribed via Groq Whisper (`stt.js`). After every successful result, `withScreenshot()` in executor wraps the return as `{ photo, caption }` and bot sends it via `ctx.replyWithPhoto`. Errors also trigger a screenshot.
- **`widget/`** — Renderer HTML/CSS/JS. Sends IPC to main: `close-app`, `switch-window`, `execute-command`, `recording-audio`, `open-settings`.

### Command Routing Pipeline (`executor.js`)

```
Input text
  1. parseCommand()      — regex rules in commands.js (instant, no LLM)
  2. isComplex()         — gate that bypasses classifyIntent for rich requests
  3. classifyIntent()    — intent.js: Groq LLM, returns simple command objects
  4. buildPlan()         — planner.js: Groq LLM, returns JSON execution_plan[]
  5. runPlan()           — orchestrator.js: runs steps sequentially, resolves {{context.key}} templates
  6. dispatch()          — executor.js: routes resolved command objects to system modules
  7. withScreenshot()    — wraps result with a programmatic screen capture
```

Steps 1 → 2 → 3 → 4 are tried in order; the first match short-circuits the rest.

### Key Modules

| File | Responsibility |
|---|---|
| `commands.js` | Regex rule array. Covers English + Turkish system commands. First match wins. Trailing punctuation stripped before matching. |
| `intent.js` | LLM intent classifier (Groq). Returns typed command objects matching dispatcher shapes. Provider auto-detected: model with `/` → OpenRouter, otherwise Groq. |
| `planner.js` | LLM task planner (Groq). Returns `{ intent, execution_plan[] }` JSON. System prompt hardcodes all available tools and examples. |
| `orchestrator.js` | Runs `execution_plan[]` sequentially. Resolves `{{context.key}}` in any parameter string/object/array. 2 retries per step, 25s timeout. |
| `tools/index.js` | `TOOL_REGISTRY` map — strings to async functions. Only tools registered here can be used in plans. |
| `system.js` | `openApp`, `captureScreen`, `takeScreenshot`, volume, lock, minimize/maximize/close, media keys — all via PowerShell. |
| `windows.js` | `switchTo(target)` — tries process name then window title. Has `PROCESS_ALIASES` map for common apps. |
| `keyboard.js` | `sendHotkey`, `pressKey` — Win32 `keybd_event` via inline C# in PowerShell. |
| `mouse.js` | `mouseClick`, `mouseDoubleClick`, `mouseScroll`, `mouseMove` — Win32 `mouse_event`. |
| `inject.js` | `injectText` (char-by-char Win32 SendInput) and `pasteText` (clipboard paste). Use `pasteText` for any Unicode/Turkish text. |
| `ps-utils.js` | `runPS(script)` — base64-encodes script, spawns `powershell.exe -EncodedCommand` hidden. All PowerShell calls go through this. |
| `gemini-browser.js` | Playwright Firefox automation for Gemini queries and image generation. Exports `getContext()` for shared browser access. |
| `ai.js` | `askClaude` (via `claude-cli.js`), `askGemini`, `generateImage`. Strips conversational filler from prompts before sending. |
| `stt.js` | Groq Whisper transcription. |
| `env-utils.js` | Reads/writes `.env` file without restarting the process. |

### Tool Registry (`tools/`)

Each file in `tools/` exports one function. `tools/index.js` registers them all in `TOOL_REGISTRY`. Adding a new capability = new file + one line in `index.js` + entry in planner's `SYSTEM_PROMPT` tool list.

| Tool | File |
|---|---|
| `web_search` | `tool_web_search.js` — fetches DuckDuckGo HTML, decodes `/l/?uddg=` redirects, returns Title/URL/Snippet |
| `youtube_first_video` | `tool_youtube_search.js` — fetches YouTube search page, regex-extracts first `videoRenderer.videoId` |
| `extract_value` | `tool_extract.js` — Groq LLM, returns exactly the requested fact from text |
| `ask_llm` | `tool_llm.js` — direct Groq question |
| `open_url` | `tool_browser.js` — validates URL has path, uses pasteText into Firefox address bar |
| `browser_search` | `tool_browser.js` — builds encoded search URL for youtube/google/reddit/etc., opens it |
| `open_file` | `tool_files.js` — base64-encodes filename, searches Desktop/Documents/Downloads via PowerShell |
| `read_clipboard` / `write_clipboard` | `tool_clipboard.js` |

### AI Services

- **Groq** (`api.groq.com/openai/v1`) — used for STT (Whisper), intent classification, planning, extraction, LLM queries. OpenAI-compatible SDK. Model defaults to `llama-3.3-70b-versatile`.
- **Claude** — invoked via `claude -p "..."` CLI subprocess (no API key needed if Claude Code is installed).
- **Gemini** — Playwright browser automation against `gemini.google.com/app`. Uses the user's real Firefox profile for persistent login.

### PowerShell Pattern

Every Windows API call goes through `runPS()` in `ps-utils.js`. Scripts are base64-encoded UTF-16LE to avoid quote escaping and Unicode issues. Inline C# (`Add-Type -TypeDefinition`) is used for Win32 P/Invoke (SendInput, SetForegroundWindow, etc.). Always use `Buffer.from(userInput, 'utf8').toString('base64')` + `[Convert]::FromBase64String()` in PS when passing user strings into scripts.

---

## Important Invariants

- **`pasteText` not `injectText` for Unicode** — `injectText` is char-by-char Win32 and breaks on Turkish/non-ASCII. Use `pasteText` for any URL or user-provided string that may contain non-ASCII.
- **`isComplex()` gate** — runs before `classifyIntent`. Turkish content commands (anything with `çal`/`oynat`/`dinle` + surrounding text, platform names, media words like `şarkı`/`albüm`, or question words like `nedir`/`nerede`) must be caught here, otherwise the intent LLM misroutes them.
- **Planner rule 10** — after `open_url` to a video/music URL, no further steps. YouTube auto-plays; extra hotkeys pause it.
- **`withScreenshot()` skips AI text/photo responses** — only wraps string results and unknown objects in a screenshot. Check `result?.text` or `result?.photo` before deciding to screenshot.
- **`open_url` validates path** — rejects bare-domain URLs (no path/query) to prevent silent fallback to a homepage when URL extraction fails upstream.

---

## Planned Upgrades (see WALTER_UPGRADE_PLAN.md)

Phase 1: `memory.js` + `walter_memory.json` persistent store  
Phase 2: Resilient `openApp()` fallback chain (Start Menu → Desktop → Program Files)  
Phase 3: `youtube_channel_latest(channel)` — channel-aware YouTube via fetch+parse  
Phase 4: `recall`/`learn` planner tools backed by memory  
Phase 5: Entity extractor pre-planner pass  
Phase 6: `scan_path` / `scan_page` tools  
Phase 7: Orchestrator per-step fallback map  
Phase 8: Self-code-editing (whitelisted files only)
