# WALTER — Advanced Pipeline Plan

## What This Is

WALTER is a voice-and-text Windows computer controller. An always-on-top Electron widget that accepts commands via Telegram (text/voice) or a local mic hotkey, and executes them on your PC.

**Input → Pipeline → Action → Screenshot back to Telegram.**

---

## Current Architecture

```
Input (Telegram text/voice / widget / mic hotkey)
  → parseCommand()     regex rules (instant, no LLM)
  → isComplex()        gate: skip intent for rich requests
  → classifyIntent()   Groq LLM → simple command object
  → buildPlan()        Groq LLM → JSON execution_plan[]
  → runPlan()          orchestrator: sequential tool calls
  → dispatch()         routes to system modules
  → withScreenshot()   wraps result with screen capture → Telegram
```

**Free AI stack:** Groq (LLM + Whisper STT), Claude CLI subprocess, Gemini browser automation.

---

## The Plan — 5 Sub-projects

Build order: 1 → 2 → 3 → 4 → 5. Sub-projects 1 and 3 can be built in parallel.

---

### Sub-project 1 — Browser Foundation
**Status:** Not started

**Goal:** Zero hardcoding. Any browser. Any URL format. Click anywhere.

**Problems this fixes:**
- `10.16.40.250:8000 adresine git` → wrong tool (`start_session` instead of `open_url`)
- Firefox hardcoded — fails if not installed
- Native Windows app elements not clickable

**What gets built:**

| File | What it does |
|---|---|
| `browser-detector.js` | Scans registry + known paths for Chrome, Edge, Opera GX, Brave, Firefox. Picks best available. Caches to memory. |
| `playwright-session.js` | Replace all hardcoded Firefox with `browser-detector.js`. |
| `tool_browser.js` | URL normalizer: bare IPs (`10.16.40.250:8000`) → `http://...`, bare domains → `https://...` |
| `ui-automation.js` | PowerShell UI Automation: walks Windows accessibility tree. `ui_click(text)` clicks any native UI element by label. |
| `tools/index.js` | Register `ui_click` tool. |
| `planner.js` | Fix: any IP/URL → `open_url`, never `start_session`. Add `ui_click` to tool list. |

---

### Sub-project 2 — Vision Layer
**Status:** Not started

**Goal:** WALTER understands what's on screen using Gemini free vision API.

**Free API:** Gemini 2.0 Flash via Google AI Studio — free, no credit card. Needs `GEMINI_API_KEY` in `.env`.

**What gets built:**

| File | What it does |
|---|---|
| `ai.js` | Add `askGeminiVision(prompt, imagePath)` — Gemini free API with image input. |
| `tools/tool_vision.js` | `analyze_screen(question)` — screenshot + Gemini answers about what's on screen. |
| `tools/tool_vision.js` | `vision_click(description)` — Gemini finds element coordinates from screenshot → mouse click. |
| `orchestrator.js` | On step failure: auto-call `analyze_screen` to explain what went wrong. |
| `planner.js` | Add `analyze_screen` + `vision_click` to tool list + examples. |

---

### Sub-project 3 — Conversation Context
**Status:** Not started

**Goal:** Commands build on each other. "Click that", "go back", "do it again" all work.

**What gets built:**

| File | What it does |
|---|---|
| `bot.js` | Rolling buffer: last 10 messages (user + WALTER) kept per session. |
| `planner.js` | Inject conversation history as multi-turn messages before current command. |
| `playwright-session.js` | Current page URL + title always included in planner context when session is active. |

---

### Sub-project 4 — Autonomous Self-Correction
**Status:** Not started

**Goal:** WALTER evaluates its own output and retries without user intervention.

**What gets built:**

| File | What it does |
|---|---|
| `orchestrator.js` | After each step: `analyze_screen("did this succeed?")` → if NO, retry with vision context (max 3 attempts). |
| `tools/tool_vision.js` | `verify_step(expected)` — checks if screen matches expected outcome. |
| `planner.js` | Support `verify_step` in plans. |

---

### Sub-project 5 — AI Pipeline Optimization
**Status:** Not started

**Goal:** Right model for the right task. Parallel execution. Smarter planning.

**What gets built:**

| File | What it does |
|---|---|
| `ai-router.js` | Routes tasks: vision → Gemini, fast/simple → Groq 8b, complex → Groq 70b, reasoning → Claude CLI. |
| `orchestrator.js` | Parallel execution for steps with no shared context dependencies. |
| `planner.js` | Confidence scoring — if unclear, ask user before executing. Richer few-shot examples. |

---

## Configuration Reference

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `ALLOWED_USER_ID` | Yes | Your Telegram numeric ID |
| `GROQ_API_KEY` | Yes | Groq (free at groq.com) — LLM + STT |
| `VISION_MODEL` | No | Vision model for analyze_screen/vision_click. Default: `meta-llama/llama-4-scout-17b-16e-instruct` (Groq, uses GROQ_API_KEY) |
| `VOICE_HOTKEY` | No | Default: Ctrl+Shift+Space |

---

## Running

```bash
npm start
```

Widget appears bottom-right. Telegram bot starts if credentials are set. Local voice works once Groq key is saved via Settings.

---

## Detailed Design

Full spec with data flows and architecture decisions:
`docs/superpowers/specs/2026-05-19-walter-advanced-pipeline-design.md`
