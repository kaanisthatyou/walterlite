# W.A.L.T.E.R. — Agentic Task Engine
**Workflow Automation with Language, Tasks, Execution, and Reasoning**

> Current WALTER/lite takes one sentence and fires one action.  
> This document defines how it becomes an agent that **thinks before it acts**, chains multi-step plans, uses tools to fill knowledge gaps, and recovers from failures — all free, all local-first.

---

## The Core Problem

Right now the pipeline is:

```
User says "Research and play Drake's new 2026 album on Spotify"
        ↓
classifyIntent() → no match → falls back to type/AI
        ↓
Gemini/Claude gets the raw prompt and tries to... do something
```

This is wrong. A real agent would notice:
- "I don't know the album name — Spotify search will fail with a vague query"
- "I need to find the real album name first"
- "Only then should I go to Spotify with a precise query"

That's **ReAct** (Reason + Act): recognize what you don't know → use a tool to find it → act with the result.

---

## Architecture: The Agentic Pipeline

```
User Input (voice/Telegram)
        │
        ▼
[STT / cleanPrompt]          ← already built
        │
        ▼
[Intent Gate]                ← is this simple or complex?
   simple → existing executor.js path (unchanged)
   complex → ↓
        │
        ▼
[Task Planner — planner.js]
  LLM produces execution_plan[]
        │
        ▼
[Orchestrator — orchestrator.js]
  Loops through plan steps
  Passes context between steps
  Handles errors + retries
        │
        ▼
[Tool Registry — tools/]
  Named tools → real WALTER functions
        │
        ▼
[Response Formatter]
  Telegram reply / widget update
```

---

## 1. The Planner (`planner.js`)

### What it does
Takes any user sentence and returns a structured `execution_plan[]` JSON. The LLM is used **as a decision engine, not a chatbot** — it must produce machine-executable steps, not prose.

### System Prompt (Groq llama-3.3-70b / any capable LLM)

```
You are WALTER's Task Planner. Your job is to decompose a user's request into
a sequential list of tool calls that will fulfill it.

AVAILABLE TOOLS:
- web_search(query)              → returns top 3 search result snippets
- web_extract(url)               → returns page text (via Playwright)
- extract_value(text, what)      → uses LLM to pull a specific value from text
- spotify_search_play(term)      → searches Spotify and plays the first result
- open_app(name)                 → launches a Windows application
- switch_to(app)                 → focuses a running app window
- type_text(text)                → types text into the focused window
- send_hotkey(combo)             → sends a keyboard shortcut (e.g. "ctrl+t")
- take_screenshot()              → captures screen, returns image path
- read_clipboard()               → returns current clipboard contents
- write_clipboard(text)          → writes text to clipboard
- ask_llm(prompt)                → asks LLM a general knowledge question
- system_action(action)          → volume, lock, minimize, maximize, close, etc.
- wait(ms)                       → wait N milliseconds

RULES:
1. Return ONLY valid JSON. No explanation. No markdown.
2. If information is missing (e.g. you don't know an album name, a URL, a price),
   add a research step BEFORE the action step.
3. Each step's output is stored as context.step_N_result.
4. Reference prior step results with {{context.step_N_result}}.
5. If a single known command can handle the request directly, return a plan with 1 step.
6. Never invent information. If you cannot figure out the plan, return:
   {"intent":"unclear","execution_plan":[]}

OUTPUT FORMAT:
{
  "intent": "...",
  "complexity": "simple|multi_step|research_required",
  "execution_plan": [
    {
      "step": 1,
      "type": "research|extract|execute|wait|confirm",
      "tool": "<tool_name>",
      "parameters": { ... },
      "store_as": "context.album_name",
      "reason": "one line why this step is needed"
    }
  ]
}
```

### Example: Drake album request

Input: `"Research and play Drake's new 2026 album on Spotify"`

LLM output:
```json
{
  "intent": "play_music_unknown_title",
  "complexity": "research_required",
  "execution_plan": [
    {
      "step": 1,
      "type": "research",
      "tool": "web_search",
      "parameters": { "query": "Drake new album 2026 name" },
      "store_as": "context.search_results",
      "reason": "Album title is unknown; need web data before Spotify can find it"
    },
    {
      "step": 2,
      "type": "extract",
      "tool": "extract_value",
      "parameters": {
        "text": "{{context.search_results}}",
        "what": "the exact name of Drake's 2026 album"
      },
      "store_as": "context.album_name",
      "reason": "Parse the album name out of raw search text"
    },
    {
      "step": 3,
      "type": "execute",
      "tool": "spotify_search_play",
      "parameters": { "term": "{{context.album_name}} Drake" },
      "reason": "Now we have the real album name — search and play"
    }
  ]
}
```

---

## 2. The Orchestrator (`orchestrator.js`)

### What it does
- Receives an `execution_plan[]` from the Planner
- Runs each step in sequence
- Resolves `{{context.*}}` template variables with prior step results
- Handles retries on failure (up to 2 retries per step)
- Replans if a step produces unexpected output (optional, Phase 2)

### Skeleton

```js
// orchestrator.js
const { TOOL_REGISTRY } = require('./tools');

async function runPlan(plan, notifyFn) {
  const context = {};

  for (const step of plan.execution_plan) {
    if (notifyFn) notifyFn('status', { state: 'processing', text: `Step ${step.step}: ${step.tool}` });

    // Resolve {{context.*}} placeholders in parameters
    const params = resolveParams(step.parameters, context);

    let result;
    let attempts = 0;
    while (attempts < 2) {
      try {
        const toolFn = TOOL_REGISTRY[step.tool];
        if (!toolFn) throw new Error(`Unknown tool: ${step.tool}`);
        result = await toolFn(params);
        break;
      } catch (err) {
        attempts++;
        if (attempts >= 2) throw new Error(`Step ${step.step} failed: ${err.message}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Store result in context under the declared key
    if (step.store_as) {
      const key = step.store_as.replace('context.', '');
      context[key] = result;
    }
  }

  return context;
}

function resolveParams(params, context) {
  const str = JSON.stringify(params);
  const resolved = str.replace(/\{\{context\.(\w+)\}\}/g, (_, key) => context[key] ?? '');
  return JSON.parse(resolved);
}

module.exports = { runPlan };
```

---

## 3. The Tool Registry (`tools/index.js`)

Each tool name maps to a real WALTER function. This is the bridge between the Planner's abstract tool names and WALTER's actual capabilities.

```js
// tools/index.js
const { switchTo }          = require('../windows');
const { sendHotkey }        = require('../keyboard');
const { injectText }        = require('../inject');
const { openApp, takeScreenshot, setVolume } = require('../system');
const { playwrightSearch }  = require('./tool_web_search');    // new
const { extractFromText }   = require('./tool_extract');       // new
const { spotifySearchPlay } = require('./tool_spotify');       // new
const { readClipboard, writeClipboard } = require('./tool_clipboard'); // new
const { askLLM }            = require('./tool_llm');           // new

const TOOL_REGISTRY = {
  web_search:         ({ query })        => playwrightSearch(query),
  web_extract:        ({ url })          => playwrightExtract(url),
  extract_value:      ({ text, what })   => extractFromText(text, what),
  spotify_search_play:({ term })         => spotifySearchPlay(term),
  open_app:           ({ name })         => openApp(name),
  switch_to:          ({ app })          => switchTo(app),
  type_text:          ({ text })         => injectText(text),
  send_hotkey:        ({ combo })        => sendHotkey(combo),
  take_screenshot:    ()                 => takeScreenshot(),
  read_clipboard:     ()                 => readClipboard(),
  write_clipboard:    ({ text })         => writeClipboard(text),
  ask_llm:            ({ prompt })       => askLLM(prompt),
  system_action:      ({ action, ...p }) => systemDispatch(action, p),
  wait:               ({ ms })           => new Promise(r => setTimeout(r, ms)),
};

module.exports = { TOOL_REGISTRY };
```

---

## 4. Intent Gate (upgrade to `executor.js`)

`executor.js` gets a new pre-check: **is this complex?** If yes, it routes to the Planner instead of the single-turn `classifyIntent`.

```js
// In executor.js execute():
async function execute(text, { notify, submit = true } = {}) {
  let cmd = parseCommand(text);

  if (cmd.type === 'type') {
    const intent = await classifyIntent(text);
    if (intent) cmd = intent;
  }

  // NEW: If intent is still unresolved OR flagged as complex, try the planner
  if (!cmd || cmd.type === 'type') {
    const plan = await buildPlan(text);           // planner.js
    if (plan && plan.execution_plan.length > 0) {
      return runPlan(plan, notify);               // orchestrator.js
    }
  }

  return dispatch(cmd, text, { notify, submit });
}
```

The planner only fires when the fast regex + intent LLM both say "I don't know what this is." Zero extra latency on simple commands.

---

## 5. New Tools to Build (in `tools/`)

| File | Tool | Builds On |
|---|---|---|
| `tool_web_search.js` | `web_search` | Playwright (already in `gemini-browser.js`) |
| `tool_web_extract.js` | `web_extract` | Playwright CDP |
| `tool_extract.js` | `extract_value` | Groq LLM call (like intent.js pattern) |
| `tool_spotify.js` | `spotify_search_play` | Win32 window focus + keyboard (no API key) |
| `tool_clipboard.js` | `read/write_clipboard` | PowerShell `Get-Clipboard` / `Set-Clipboard` |
| `tool_llm.js` | `ask_llm` | Groq free tier (reuse intent.js client) |
| `tool_screenshot_read.js` | `read_screen` | takeScreenshot + Gemini vision (Phase 2) |

All tools follow the same contract: `async (params) => string | object`.

---

## 6. The Complexity Classifier

Before hitting the Planner (which costs a full LLM call), a fast heuristic gates it:

```js
function isComplexRequest(text) {
  const triggers = [
    /\b(find|search|look up|research|check|get me)\b/i,
    /\b(then|after that|and then|followed by)\b/i,
    /\b(latest|newest|current|today'?s?|2026)\b/i,
    /\b(based on|using|with the result)\b/i,
  ];
  return triggers.some(r => r.test(text));
}
```

Simple commands ("volume up", "take a screenshot") never touch the Planner. Only ambiguous multi-step or research-requiring requests do.

---

## 7. Phase Plan

### Phase 1 — Foundation (build this first)
- [ ] `planner.js` — system prompt + Groq call + JSON parse
- [ ] `orchestrator.js` — sequential runner + context store + retry
- [ ] `tools/index.js` — registry wiring existing WALTER functions
- [ ] `tool_web_search.js` — Playwright Google/DuckDuckGo search
- [ ] `tool_extract.js` — LLM value extractor
- [ ] `tool_clipboard.js` — PowerShell read/write clipboard
- [ ] Intent gate in `executor.js`
- [ ] Complexity heuristic gate

**Test case:** "Search for the latest SpaceX news and tell me the headline"

### Phase 2 — App Control Tools
- [ ] `tool_spotify.js` — focus Spotify → Ctrl+L → type → Enter
- [ ] `tool_browser.js` — open URL in Firefox, extract content
- [ ] `tool_youtube.js` — open YouTube, search, play first result
- [ ] `tool_file.js` — read/write/list files via PowerShell
- [ ] Confirm step type — ask user before irreversible actions

**Test case:** "Research Drake's new album and play it on Spotify"

### Phase 3 — Screen Awareness
- [ ] `tool_screenshot_read.js` — take screenshot → Gemini vision → describe what's on screen
- [ ] Context injection: active window title fed into Planner prompt
- [ ] Error recovery: if step fails, Planner can see screenshot and replan

**Test case:** "What's on my screen right now? Summarize it."

### Phase 4 — Memory & Personalization
- [ ] Session memory: last 10 commands in context
- [ ] Long-term memory: user preferences stored in JSON (favourite apps, shortcuts)
- [ ] `tool_memory.js` — store/recall facts ("my Spotify username is...", "my work folder is...")
- [ ] Planner uses memory as context before generating plan

**Test case:** "Open my usual morning apps" (Walter remembers what those are)

### Phase 5 — Proactive Agent Mode
- [ ] Scheduled tasks: "every morning at 9am, check the weather and tell me"
- [ ] Trigger-based: "when I open VS Code, mute my mic automatically"
- [ ] Background monitoring: clipboard watcher, app launch hooks
- [ ] Walter can initiate — not just respond

---

## 8. Design Principles

1. **Regex first, LLM last** — fast path is always the regex in `commands.js`. LLM only when needed.
2. **Plan once, execute dumb** — the Planner thinks, the Orchestrator executes mechanically. No LLM calls inside tool execution.
3. **Every tool is independently testable** — `tools/` folder, each file exports one async function, can be called standalone.
4. **Fail loudly in dev, degrade gracefully in prod** — errors go to Telegram as readable messages.
5. **No paid APIs** — Groq free tier for LLM, Playwright for browser automation, Win32 for everything else.
6. **State is ephemeral** — context object lives for the duration of one plan execution. No global state mutations.

---

## 9. The WALTER Identity Prompt (global preprompt layer)

Every Planner call is prefixed with this identity so the LLM knows who it's working for:

```
You are WALTER — a personal AI agent running on a Windows PC.
You have direct access to the user's desktop: you can control apps,
browse the web, read/write files, and execute system actions.
The user speaks to you via voice or Telegram from their phone.
Your job is to get things done, not to explain. Be precise, be fast.
```

---

## Future Scope Notes

- **Local LLM via VRAM**: Replace Groq API calls with a locally-hosted model (Ollama + llama3 / mistral / deepseek) for fully offline operation. The `intent.js` and `planner.js` OpenAI-compatible client interface makes this a one-line baseURL swap. Priority targets: RTX 3060 12GB runs Llama 3.1 8B at ~80 tok/s — fast enough for real-time intent. 70B would need quantization (Q4_K_M) or a better GPU.
- **Vision-native planning**: When a local vision model (LLaVA, Qwen-VL) is available, Planner gets a screenshot at every step — it can see the screen, not just be told about it.
- **Walter Server mode**: Run WALTER headless on a home server, expose a local API, multiple devices connect to the same agent brain.
