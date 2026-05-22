# WALTER/lite — Finalization Plan

## Status: What Is Already Built

The core pipeline is complete and all five original sub-projects are done.

```
Input (Telegram text/voice / widget / mic hotkey)
  → parseCommand()     regex rules (instant, no LLM)
  → isComplex()        gate: skip intent for rich requests
  → classifyIntent()   Groq LLM → simple command object
  → buildPlan()        Groq LLM → JSON execution_plan[]
  → runPlan()          orchestrator: sequential tool calls, retries, fallbacks
  → dispatch()         routes to system modules
  → withScreenshot()   wraps result with screen capture → Telegram
```

### Built and Working

| Component | File(s) |
|---|---|
| Browser detector (Chrome/Edge/Brave/Firefox) | `browser-detector.js` |
| Playwright session automation | `playwright-session.js` |
| URL normalizer (bare IPs, bare domains) | `tool_browser.js` |
| UI Automation (Windows accessibility tree) | `ui-automation.js`, `tools/index.js` |
| Vision tools: `analyze_screen`, `vision_click` | `tools/tool_vision.js` |
| Conversation history (rolling buffer) | `conversation.js`, `bot.js` |
| Memory tools: `recall`, `learn` | `tools/tool_memory.js` |
| Scan tools: `scan_path`, `scan_page` | `tools/tool_scan.js` |
| Claude CLI single-shot tool: `ask_claude` | `tools/tool_claude_task.js` |
| Claude multi-turn session tools | `tools/tool_claude_session.js` |
| Session recording / replay | `playwright-session.js` |
| Parallel intent model support (OpenRouter routing) | `intent.js` |
| Step fallbacks (web_search → Bing, open_url → Google) | `orchestrator.js` |
| Vision-guided error reporting on step failure | `orchestrator.js` |
| Prefix/macro session runner | `prefix-registry.js`, `macro-runner.js` |
| Settings UI (env vars live edit) | `widget/settings.html`, `env-utils.js` |

---

## What Remains — 4-Tier Finalization Plan

---

### Tier 1 — Reliability
**Goal:** WALTER never gets stuck. Failures recover gracefully.

| Item | Status | File(s) |
|---|---|---|
| `openApp()` fallback chain (Start Menu → Desktop → Program Files search) | IN PROGRESS | `system.js` |
| Smarter `session_step` settle wait (adaptive vs. fixed sleep) | IN PROGRESS | `playwright-session.js` |

---

### Tier 2 — Intelligence
**Goal:** WALTER understands richer context and handles media/channel commands.

| Item | Status | File(s) |
|---|---|---|
| Entity extractor pre-planner pass (strip entities before LLM routing) | IN PROGRESS | `executor.js`, new `entity-extractor.js` |
| `youtube_channel_latest(channel)` tool | IN PROGRESS | `tools/tool_youtube_search.js` |
| `verify_step(expected)` confirmation tool | IN PROGRESS | `tools/tool_vision.js`, `orchestrator.js` |

---

### Tier 3 — Performance
**Goal:** Multi-step plans run faster; intent model is decoupled from planner.

| Item | Status | File(s) |
|---|---|---|
| Parallel wave execution (independent steps run concurrently) | IN PROGRESS | `orchestrator.js` |
| Intent model decoupling (dedicated fast model vs. planner model) | IN PROGRESS | `intent.js`, `planner.js` |

---

### Tier 4 — Polish
**Goal:** Tighter UX. User can abort plans mid-execution. Widget shows live progress.

| Item | Status | File(s) |
|---|---|---|
| Confidence gate: planner asks user before low-confidence plans execute | TODO | `planner.js`, `bot.js` |
| Widget step progress display (Step N/M: tool_name live in widget) | DONE | `widget/index.html`, `widget/preload.js`, `main.js` |
| `/abort` command cancels running plan mid-execution | DONE | `bot.js`, `orchestrator.js` |

---

## Configuration Reference

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `ALLOWED_USER_ID` | Yes | Your Telegram numeric ID |
| `GROQ_API_KEY` | Yes | Groq (free at groq.com) — LLM + STT |
| `GEMINI_API_KEY` | No | Google AI Studio (free) — vision tools |
| `INTENT_API_KEY` | No | Override API key for intent model |
| `INTENT_MODEL` | No | Override intent classifier model |
| `PLANNER_MODEL` | No | Override planner model |
| `VOICE_HOTKEY` | No | Default: Ctrl+Shift+Space |

## Running

```bash
npm start
```

Widget appears bottom-right. Telegram bot starts if credentials are set.
Local voice works once Groq key is saved via Settings.
