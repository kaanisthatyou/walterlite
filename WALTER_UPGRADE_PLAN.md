# WALTER Intelligence Upgrade Plan
## Vision, Architecture & Phased Roadmap

---

## Vision

WALTER should never give up. Every failure is a search opportunity. Every success is a learning opportunity.
The goal is a system that gets smarter with every interaction — remembering what it discovers, finding
alternative paths when the first fails, and using context-aware reasoning instead of brute-force keyword search.

**The Imorr Example (north star for this upgrade):**
> User: "Imorr kanalından en son videoyu aç"

❌ Current (dumb): YouTube search "Imorr kanalından en son video" → generic result → wrong video
✅ Target (smart):
1. Recognize "Imorr" as a YouTube channel entity, "en son video" as intent
2. Check memory → is Imorr's channel URL already known?
3. If not: find the channel URL (YouTube search for "@Imorr" or channel page)
4. Navigate to channel, scrape the latest video with Playwright or fetch+parse
5. Open the video directly
6. Save: `memory["youtube_channel:imorr"] = "https://youtube.com/@Imorr"`

Next time: Step 2 hits memory → jumps straight to step 4. No re-searching.

---

## Current State

```
Input
  → parseCommand (regex)
  → isComplex gate
  → classifyIntent (LLM, simple commands)
  → buildPlan (LLM, complex multi-step)
  → runPlan (orchestrator, sequential tool calls)
  → dispatch
  → Result / Error (no fallback, no memory)
```

**Gaps:**
- No persistent memory across sessions
- No entity recognition (channel vs keyword vs artist vs file)
- No fallback when a step fails
- App search is single-attempt (`Start-Process name`)
- YouTube always does generic keyword search even for specific channels/artists
- Planner has no way to store or retrieve learned facts
- No web scraping intelligence beyond basic HTML extraction

---

## Architecture After Upgrade

```
Input
  → parseCommand (regex — unchanged, fast)
  → Entity Extractor (NEW — detect what kind of thing is being asked about)
  → Memory Lookup (NEW — check if we already know the answer)
  → isComplex gate (enhanced)
  → classifyIntent (LLM, simple commands)
  → buildPlan (LLM — with memory context injected)
  → runPlan (orchestrator — with per-step fallback chains)
  → dispatch (with fallback chains for app/switch)
  → Auto-learn from result (NEW — save discoveries to memory)
  → Screenshot + Result
```

---

## New Files to Create

| File | Purpose |
|---|---|
| `memory.js` | Read/write `walter_memory.json` with typed namespaces |
| `walter_memory.json` | Persistent key-value store for all learned facts |
| `tools/tool_memory.js` | `recall(key)` and `learn(key, value)` planner tools |
| `tools/tool_youtube_channel.js` | `youtube_channel_latest(channel)` — channel-aware YouTube tool |
| `tools/tool_scan.js` | `scan_path(dir)` and `scan_page(url)` |
| `entity.js` | Entity extractor — classify what the user is referring to |
| `fallback.js` | Fallback chain runner for app opening, search, etc. |

## Files to Modify

| File | Change |
|---|---|
| `system.js` | `openApp()` → multi-step fallback chain, saves path to memory |
| `executor.js` | Inject memory context before planning, auto-learn after success |
| `planner.js` | Add recall/learn/youtube_channel_latest/scan_* to tool list + examples |
| `tools/index.js` | Register new tools |
| `orchestrator.js` | Per-step fallback: on fail, attempt alternate tool/params |

---

## Phase 1 — Memory Foundation

**Goal:** A reliable read/write memory system that all other phases depend on.

### `walter_memory.json` schema
```json
{
  "apps": {
    "obsidian": "C:\\Users\\ADAS\\AppData\\Local\\Obsidian\\Obsidian.exe",
    "noter": "C:\\Users\\ADAS\\Desktop\\noter.lnk"
  },
  "youtube_channels": {
    "imorr": "https://www.youtube.com/@Imorr",
    "kuruluş osman": "https://www.youtube.com/@KurulusOsman"
  },
  "sites": {
    "sahibinden": "https://www.sahibinden.com",
    "is takvimi": "https://calendar.google.com/..."
  },
  "facts": {
    "my_city": "Istanbul",
    "preferred_music_platform": "youtube"
  },
  "path_scans": {
    "desktop_last_scanned": "2025-05-15T10:00:00Z",
    "desktop_apps": ["noter.lnk", "obsidian.lnk"]
  }
}
```

### `memory.js` API
```javascript
memory.get(namespace, key)          // → value or null
memory.set(namespace, key, value)   // → saves to JSON file
memory.search(namespace, partial)   // → fuzzy-match key lookup
memory.getAll(namespace)            // → full namespace object
```

### Planner Tools
- `recall(key)` — planner calls this to check memory before doing a web_search
- `learn(key, value)` — planner calls this after discovering something to save it

**Rule in planner:** Before web_search for a known entity type (channel, app, site), always call `recall` first.

---

## Phase 2 — Resilient App Opening

**Goal:** `openApp("obsidian")` never fails silently — it searches, finds, remembers.

### Fallback Chain for `openApp(name)`

```
Step 1: memory.get("apps", name) → if found, Start-Process <path> → done, exit
Step 2: Get-StartApps | Where-Object Name -like "*name*" → if found, launch, save to memory
Step 3: Search-Desktop (.lnk files matching name)       → if found, launch, save to memory
Step 4: Search C:\Program Files\ and C:\Program Files (x86)\ for name.exe
Step 5: Search $env:LOCALAPPDATA recursively (depth 3) for name.exe
Step 6: Throw with helpful message — "Bulunamadı: obsidian. Tam yolu verir misin?"
```

### Fallback Chain for `switchTo(app)`

```
Step 1: Find by process name matching app
Step 2: Find by window title containing app name
Step 3: Try openApp(app) — maybe it's not running yet
Step 4: Throw
```

### Auto-Save Discovery
When any step > 1 succeeds, immediately:
```javascript
memory.set("apps", name, foundPath);
// Next time: Step 1 hits cache → instant open
```

---

## Phase 3 — YouTube & Media Intelligence

**Goal:** Recognize WHAT kind of media request this is and handle it correctly.

### Entity Types for YouTube

| Type | Detection Signal | Example | Best Tool |
|---|---|---|---|
| **Channel — latest video** | "kanal", "kanalından", "en son video", channel name is proper noun | "Imorr kanalından en son video" | `youtube_channel_latest` |
| **Channel — browse** | "kanala git", "kanalını aç" | "Imorr'un kanalını aç" | `open_url(channel_url)` |
| **Specific video** | known title, quotes, exact name | '"Bohemian Rhapsody" aç' | `youtube_first_video` |
| **Artist latest** | artist name + "son şarkı/albüm" | "Drake'in son şarkısı" | `web_search` → `youtube_first_video` |
| **Generic search** | "...çal", "...bul", keyword-like | "lofi müzik çal" | `youtube_first_video` |
| **Browse/search** | "ara", "search" explicit | "youtube'da lofi ara" | `browser_search` |

### New Tool: `youtube_channel_latest(channel_name_or_url)`

```
1. Check memory["youtube_channels"][channel_name] → get URL if known
2. If not known:
   a. Search YouTube for "@{channel_name} channel" via fetch+parse
   b. Find channel URL from results (youtube.com/@ChannelName pattern)
   c. Save: memory.set("youtube_channels", channel_name, channel_url)
3. Fetch channel page HTML (/videos tab)
4. Parse ytInitialData JSON embedded in page
5. Extract first videoId from gridVideoRenderer or richItemRenderer
6. Return https://www.youtube.com/watch?v={videoId}
```

This is entirely fetch-based — no Playwright needed for most channels.

**For channels with age-gate or unusual structure:** Playwright fallback via shared context.

### Smart Query Routing in Planner

Add a pre-planning rule: before generating a YouTube plan, classify the media intent:
- Has "kanal" / "channel" / "kanalından" → `youtube_channel_latest`
- Has artist name + "son şarkı/albüm" → `web_search` → `youtube_first_video`
- Has specific title → `youtube_first_video` directly
- Generic → `youtube_first_video`

### Memory Integration for YouTube
- After `youtube_channel_latest` succeeds: auto-save channel URL
- After `youtube_first_video` succeeds with specific artist: could save "artist:drake → verified"
- Planner always calls `recall("youtube_channel", name)` before searching

---

## Phase 4 — Entity Extractor

**Goal:** Before planning, classify WHAT the user is asking about so the plan is smarter.

### `entity.js` — lightweight pre-planner classifier

Runs BEFORE `buildPlan`. Identifies entities without an LLM call (regex + pattern matching first, LLM only if needed).

```javascript
extractEntities(text) → {
  type: "youtube_channel" | "youtube_video" | "app" | "file" | "website" | "question" | "command",
  name: "Imorr",
  intent: "latest_video" | "browse" | "play" | "open" | "search",
  platform: "youtube" | "spotify" | "system" | null,
  memoryHint: "youtube_channels:imorr" // key to check in memory
}
```

### Detection Rules (regex-first, LLM fallback)

```
"kanalından" / "kanalını" / "channel"         → type: youtube_channel
"en son / son / latest" + media word           → intent: latest
"ara" / "search" explicit                      → intent: browse
proper noun (capitalized, known entity) alone  → type: channel/artist (check memory)
".exe" / ".pdf" / file extension               → type: file
known app name (from memory["apps"])           → type: app
URL pattern                                    → type: website
```

### Memory-First Resolution
When entity extractor finds a match and memory has the key:
```
"Imorr kanalından en son video"
→ entity: { type: youtube_channel, name: "imorr" }
→ memory.get("youtube_channels", "imorr") → "https://youtube.com/@Imorr"
→ Inject into plan context: context.channel_url = "https://youtube.com/@Imorr"
→ Planner skips discovery, goes straight to fetch latest video
```

---

## Phase 5 — Scan Tools

**Goal:** Walter can be told to explore a path or page and remember what it finds.

### `scan_path(directory)`

```javascript
// "Masaüstünü tara" → scan_path("Desktop")
// Returns list of discovered apps/files, saves to memory

scan_path("Desktop") → {
  found: ["Obsidian.lnk", "noter.exe", "proje.pdf"],
  saved: { "apps.obsidian": "...", "apps.noter": "..." }
}
```

Implementation: PowerShell `Get-ChildItem` with `.exe` and `.lnk` filtering, save each to `memory["apps"]`.

### `scan_page(url, what_to_remember)`

```javascript
// "Sahibinden'i kaydet"
// → scan_page("https://www.sahibinden.com", "remember this as my go-to classifieds site")

scan_page(url, hint) → {
  title: "Sahibinden.com",
  description: "...",
  saved_as: "sites.sahibinden"
}
```

Implementation: fetch page → extract title + meta description → `ask_llm` to derive a clean label → save to memory.

### `scan_screen()`

Uses `captureScreen()` + vision-capable LLM (if available) or OCR to describe what's currently visible.
Future scope — depends on vision model availability.

---

## Phase 6 — Orchestrator Fallbacks ✅ DONE

**Goal:** When a plan step fails, try an alternative before giving up.

### Per-Step Fallback Map

```javascript
const STEP_FALLBACKS = {
  youtube_first_video: async (params, err) => {
    // Fallback: try with simplified query
    return youtube_first_video({ query: simplify(params.query) });
  },
  web_search: async (params, err) => {
    // Fallback: try Bing or Google instead of DuckDuckGo
    return web_search_bing(params);
  },
  open_url: async (params, err) => {
    // If URL is malformed or 404: try web_search for the domain
    return browser_search("google", params.url);
  },
  switch_to: async (params, err) => {
    // If window not found: try launching the app
    return openApp(params.app);
  },
};
```

### Orchestrator Change

```javascript
// In runPlan, per step:
try {
  result = await toolFn(params);
} catch (err) {
  const fallback = STEP_FALLBACKS[step.tool];
  if (fallback) {
    result = await fallback(params, err); // try alternative
  } else {
    throw err; // no fallback defined, propagate
  }
}
```

---

## Phase 7 — Self-Code-Editing (Future Scope)

**Goal:** Walter can add new regex patterns, planner examples, and custom commands by editing its own source files.

### Required Tools
- `read_source(filename)` — read a WALTER source file (whitelisted paths only)
- `edit_source(filename, old_text, new_text)` — safe edit with syntax validation

### Safety Rules
- Only whitelisted files: `commands.js`, `planner.js` SYSTEM_PROMPT section, `intent.js` SYSTEM_PROMPT
- Edit must pass `JSON.parse` or `/^const RULES/` syntax check before writing
- Automatic git commit after edit (if git is available)
- User confirmation required via Telegram before writing

### Example Use Case
> "Bunu öğren: 'ışıkları aç' dediğimde Ctrl+Alt+L kombinasyonu gönder"

```
1. ask_llm: "What regex pattern matches 'ışıkları aç'?"
2. read_source("commands.js") → get current RULES array
3. Generate new rule: [/^ışıkları aç$/i, () => ({ type: 'hotkey', combo: 'ctrl+alt+l' })]
4. edit_source: insert rule before the Turkish section
5. Hot-reload picks up the change → immediately available
```

---

## Phase 9 — Prefix Sessions & Live Browser Automation ✅ DONE

**Goal:** Short prefix codes put WALTER into a persistent **session mode** for a specific web app. While inside the session, every message is interpreted in that context — WALTER guides you step by step through multi-step flows, prompts for input when needed, auto-executes silent steps, and stays active until you explicitly cancel.

### North Star Example

```
You:    HBYS
WALTER: 📋 HBYS — Hastane Bilgi Yönetim Sistemi
        [Sistem Yönetimi]  [Hasta Ara]
        [Yeni Hasta Kaydı] [Sayfayı Tara]

You:    (taps Yeni Hasta Kaydı)
WALTER: ✓ Sayfaya gidildi. Hasta adı soyadını gir:

You:    Ahmet Yılmaz
WALTER: ✓ Ad soyad girildi. Doğum tarihini gir (GG.AA.YYYY):

You:    15.03.1985
WALTER: ✓ Tarih girildi. Kaydet?
        [Evet, Kaydet]  [Vazgeç]

You:    (taps Evet, Kaydet)
WALTER: ✓ Hasta kaydedildi. [screenshot]
        ─────────────────────────────
        📋 HBYS aktif. Ne yapayım?
        [Sistem Yönetimi]  [Hasta Ara]
        [Yeni Hasta Kaydı] [Sayfayı Tara]
        [❌ Oturumu Kapat]

You:    iptal
WALTER: ✓ HBYS oturumu kapatıldı.
```

The menu reappears after every completed action. Session stays open until explicit cancel.

---

### Session State (in-memory, single user)

```javascript
// session.js — lives in memory, not persisted
const session = {
  activePrefix: null,       // "HBYS" or null
  activeMacro: null,        // currently executing macro id
  currentStep: 0,           // index in macro.steps[]
  collectedInputs: {},      // { fieldName: value } gathered so far
};
```

Since WALTER is single-user, a plain module-level object is sufficient. No DB needed.

---

### Message Flow (bot.js)

```
Incoming text message
  │
  ├─ Is CANCEL word? ("iptal", "cancel", "çıkış", "kapat", "dur", "exit")
  │    → clearSession() → "✓ {prefix} oturumu kapatıldı."
  │
  ├─ session.activePrefix is set?
  │    → sessionHandler(text) — interprets input in session context
  │       ├─ No active macro → treat as macro selection (button tap or text match)
  │       └─ Active macro, waiting for input → feed text as next {{input}} value
  │
  └─ No active session
       → normal WALTER routing (parseCommand → intent → planner)
       ├─ Text matches a registered prefix (e.g. "HBYS") → enterSession("HBYS")
       └─ Otherwise → existing behavior unchanged
```

---

### New Files

| File | Purpose |
|---|---|
| `session.js` | In-memory session state: activePrefix, activeMacro, currentStep, collectedInputs |
| `prefixes.json` | Registry of prefix codes → app config + macro definitions |
| `prefix-registry.js` | Load/save/lookup/define prefix configs |
| `macro-runner.js` | Step-by-step macro executor: runs one step at a time, pauses on `{{input}}` |
| `tools/tool_chrome.js` | Playwright CDP connection to existing Chrome tab |
| `tools/tool_page_study.js` | Scrape live DOM → extract interactive elements → return structured action list |

---

### `prefixes.json` Schema

```json
{
  "HBYS": {
    "label": "Hastane Bilgi Yönetim Sistemi",
    "baseUrl": "http://10.16.40.250:8000",
    "macros": [
      {
        "id": "goto_sysadmin",
        "label": "Sistem Yönetimi",
        "steps": [
          { "action": "navigate", "url": "http://10.16.40.250:8000/SistemYönetimi" }
        ]
      },
      {
        "id": "new_patient",
        "label": "Yeni Hasta Kaydı",
        "steps": [
          { "action": "navigate",  "url": "http://10.16.40.250:8000/Hasta/Yeni" },
          { "action": "click",     "selector": "#btnYeniKayit" },
          { "action": "prompt",    "field": "adSoyad",     "message": "Hasta adı soyadını gir:" },
          { "action": "fill",      "selector": "#txtAdSoyad", "value": "{{adSoyad}}" },
          { "action": "prompt",    "field": "dogumTarihi", "message": "Doğum tarihini gir (GG.AA.YYYY):" },
          { "action": "fill",      "selector": "#txtDogumTarihi", "value": "{{dogumTarihi}}" },
          { "action": "confirm",   "message": "Kaydet?" },
          { "action": "click",     "selector": "#btnKaydet" },
          { "action": "screenshot" }
        ]
      },
      {
        "id": "study_page",
        "label": "Sayfayı Tara",
        "steps": [
          { "action": "study_current_page" }
        ]
      }
    ]
  }
}
```

---

### Macro Step Types

| Action | Parameters | Behavior |
|---|---|---|
| `navigate` | `url` | Go to URL — auto-executes, no user prompt |
| `click` | `selector` | Click element — auto-executes |
| `fill` | `selector`, `value` | Fill input with value (may reference `{{fieldName}}`) — auto-executes |
| `select` | `selector`, `value` | Pick dropdown option — auto-executes |
| `wait` | `ms` | Pause — auto-executes silently |
| `wait_for` | `selector` | Wait until element visible — auto-executes |
| `prompt` | `field`, `message` | **Pauses** — sends message to user, waits for their text reply, stores in `collectedInputs[field]` |
| `confirm` | `message` | **Pauses** — sends Yes/No inline buttons, waits for tap |
| `screenshot` | — | Captures and sends screen — auto-executes |
| `study_current_page` | — | Reads live DOM, generates new inline buttons, optionally saves to `prefixes.json` |

**Key distinction:** `prompt` and `confirm` are the only blocking steps. Everything else runs silently in sequence and reports back only as a status line before the next prompt.

---

### `macro-runner.js` — Step-by-Step Execution

```javascript
// Called once per user message while a macro is active.
// Runs forward from currentStep until it hits a blocking step or the end.

async function advanceSession(session, userInput, sendFn) {
  const macro = getMacro(session.activePrefix, session.activeMacro);

  // If previous step was a prompt, store the user's answer first
  if (session.waitingFor) {
    session.collectedInputs[session.waitingFor] = userInput;
    session.waitingFor = null;
    session.currentStep++;
  }

  while (session.currentStep < macro.steps.length) {
    const step = macro.steps[session.currentStep];

    if (step.action === 'prompt') {
      session.waitingFor = step.field;
      await sendFn(step.message);
      return; // pause — wait for user reply
    }

    if (step.action === 'confirm') {
      await sendFn(step.message, { buttons: ['Evet', 'Vazgeç'] });
      session.waitingForConfirm = true;
      return; // pause — wait for user tap
    }

    // Auto-execute step (navigate, click, fill, etc.)
    const resolved = resolveTemplates(step, session.collectedInputs);
    await executeStep(resolved);
    session.currentStep++;
  }

  // Macro complete — clear macro state, re-show main menu
  session.activeMacro = null;
  session.currentStep = 0;
  session.collectedInputs = {};
  await sendFn('✓ Tamamlandı.', { showMenu: true });
}
```

---

### `tool_page_study.js` — Smart Page Scanning

When user picks "Sayfayı Tara":

```
1. Connect to active Chrome tab via Playwright CDP
2. Extract from DOM:
   - All <button> / <input type="submit"> → visible text
   - All <a> links with on-page hrefs → anchor text + href
   - All <input>/<select>/<textarea> → label text + id/name
   - Visible <h1>/<h2> → page context
3. Send summary to LLM: "What are the 5 most useful user actions on this page?"
4. LLM returns action list → convert to macro steps
5. Send as inline keyboard buttons in Telegram
6. Optionally: save generated macros to prefixes.json so they persist
```

---

### Chrome Connection via CDP

Launch Chrome once with remote debugging enabled:
```
chrome.exe --remote-debugging-port=9222
```

Add this to Chrome's desktop shortcut target. Then `tool_chrome.js`:
```javascript
const { chromium } = require('playwright');

async function getActivePage() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const pages = browser.contexts().flatMap(c => c.pages());
  // Return the page that was most recently focused
  return pages[pages.length - 1];
}
```

No new window opens — WALTER drives whatever tab is already visible.

---

### Cancel Commands

Any of the following while in a session immediately clears state and sends confirmation:

```
iptal / cancel / çıkış / kapat / dur / exit / stop / vazgeç
```

Plus a permanent **[❌ Oturumu Kapat]** button always present at the bottom of the menu.

---

### Defining New Prefix Macros

**Via Telegram (conversational):**
```
HBYS öğren
```
→ WALTER enters "learning mode" for HBYS, runs `study_current_page`, generates macros, asks "Bu şekilde kaydedeyim mi?" → saves on confirm.

**Via `prefixes.json` directly** (manual, full control):
Edit the JSON file, WALTER hot-reloads it on next command.

---

### Use Cases

| User Does | Result |
|---|---|
| Types `HBYS` | Enters HBYS session, sends macro menu |
| Taps a macro button | Executes auto-steps, pauses on `prompt`/`confirm` |
| Replies to a prompt | Input stored, execution continues to next pause point |
| Types "iptal" at any point | Session cleared immediately |
| Taps "Sayfayı Tara" | Reads live Chrome DOM → AI-generates step-by-step macro |
| Completes a macro | Screenshot sent, main menu re-shown (session still active) |
| Types `HBYS` while already in HBYS | Re-shows main menu (no duplicate session) |
| Types any other caps code while in session | "HBYS oturumundasın. İptal etmek ister misin?" |

---

## Phase 10 — Playwright Remote Control & Auto-Recording ✅ DONE
## Phase 10b — Zero-Friction Browser Control ✅ DONE

**Goal:** WALTER owns a persistent Playwright browser. You pilot it entirely from Telegram — every page change sends a screenshot back to you. Every command you give is silently recorded. At any point you can save the session as a named macro that runs automatically next time.

This is the foundation that Phase 9's prefix macros are built on. Playwright replaces the CDP + "existing Chrome" approach entirely — WALTER controls its own browser instance.

---

### The Mental Model

Think of it as a remote desktop session, but smarter:
- WALTER is the hands (Playwright browser)
- Telegram is your eyes (every action → screenshot)
- You speak in plain language, not CSS selectors
- Everything is being recorded the whole time

---

### North Star Example

```
You:    tarayıcı aç sahibinden.com
WALTER: [screenshot of sahibinden homepage]
        Tarayıcı hazır. Ne yapayım?

You:    arama kutusuna tıkla
WALTER: [screenshot — search box focused]
        Tıklandı. Devam?

You:    "ikinci el araba" yaz
WALTER: [screenshot — text typed in search box]
        Yazıldı. Devam?

You:    ara butonuna tıkla
WALTER: [screenshot — results page]
        Arama yapıldı. Devam?

You:    kaydet SAHİBİNDEN
WALTER: ✓ "SAHİBİNDEN" olarak kaydedildi (3 adım).
        Artık "SAHİBİNDEN" yazınca bu akışı tekrar oynatırım.

--- Next time ---
You:    SAHİBİNDEN
WALTER: [screenshot — results page, 3 steps ran silently]
```

---

### Architecture

```
"tarayıcı aç X" or "remote X"
  → RecordingSession starts
  → playwright-session.js creates/reuses Playwright browser
  → Navigate to URL
  → screenshot → Telegram

Each subsequent message while session active:
  → NL command → ask_llm to classify: { action, target, value }
  → Execute via Playwright (click, fill, navigate, scroll, etc.)
  → Append step to recording buffer
  → Screenshot → Telegram

"kaydet NAME"
  → recording buffer → prefixes.json as new macro
  → session cleared

"iptal"
  → session cleared, browser stays open
```

---

### New File: `playwright-session.js`

WALTER's owned browser instance — shared across all Playwright operations.

```javascript
const { chromium } = require('playwright');

let _browser = null;
let _page    = null;

async function getPage() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({ headless: false }); // visible browser
    _page    = await _browser.newPage();
  }
  if (!_page || _page.isClosed()) {
    _page = await _browser.newPage();
  }
  return _page;
}

async function navigate(url)           { const p = await getPage(); await p.goto(url, { waitUntil: 'domcontentloaded' }); }
async function screenshot()            { const p = await getPage(); return p.screenshot({ type: 'png' }); }
async function clickElement(desc)      { /* NL → selector resolution → p.click() */ }
async function fillElement(desc, val)  { /* NL → selector resolution → p.fill() */ }
async function scrollPage(dir)         { const p = await getPage(); await p.keyboard.press(dir === 'down' ? 'PageDown' : 'PageUp'); }
async function closeBrowser()          { if (_browser) { await _browser.close(); _browser = null; _page = null; } }

module.exports = { getPage, navigate, screenshot, clickElement, fillElement, scrollPage, closeBrowser };
```

Browser is **visible** (`headless: false`) — you can see it on the Windows desktop as it follows your commands.

---

### NL-to-Action Classification

Before executing a Telegram command during a recording session, a single `ask_llm` call classifies it:

```
System: "You are interpreting browser commands. Given the user's message and the current page screenshot, return JSON: { action: 'click|fill|navigate|scroll|back|screenshot', target: 'element description or URL', value: 'text to type if fill' }. Return ONLY valid JSON."

User message: "arama kutusuna tıkla"
→ { "action": "click", "target": "search input box" }

User message: "ikinci el araba yaz"
→ { "action": "fill", "target": "focused input", "value": "ikinci el araba" }

User message: "sahibinden.com'a git"
→ { "action": "navigate", "target": "https://www.sahibinden.com" }
```

Then Playwright resolves the natural-language target description to a selector via:
1. Playwright's built-in `page.getByRole`, `page.getByText`, `page.getByPlaceholder` (works for most cases)
2. If those fail: ask LLM with page DOM snapshot to generate a CSS selector

---

### Recording Buffer

Every executed step is appended automatically:

```javascript
const recordingBuffer = [];

// After each successful action:
recordingBuffer.push({
  action:   classified.action,   // 'click', 'fill', 'navigate', etc.
  target:   classified.target,
  value:    classified.value,
  selector: resolvedSelector,    // actual CSS selector used — for reliable replay
});
```

When saved, the buffer becomes a `prefixes.json` macro with `selector`-based steps so replay doesn't need NL resolution again — it's already concrete.

---

### Saving a Recording

```
You: kaydet SAHİBİNDEN
```

```javascript
// Convert buffer to macro steps
const steps = recordingBuffer.map(s => ({
  action:   s.action === 'click'    ? 'click'    :
            s.action === 'fill'     ? 'fill'     :
            s.action === 'navigate' ? 'navigate' : s.action,
  selector: s.selector,
  url:      s.target,
  value:    s.value,
}));

// Save to prefixes.json
prefixRegistry.set('SAHİBİNDEN', {
  label:  'SAHİBİNDEN',
  macros: [{ id: 'replay', label: 'Tekrar Oynat', steps }],
});
```

Next time "SAHİBİNDEN" is typed, the saved steps run silently via Playwright and the final screenshot is sent.

---

### Replay Mode

When a saved prefix macro runs via Playwright:

```javascript
async function replayMacro(steps) {
  const page = await getPage();
  for (const step of steps) {
    switch (step.action) {
      case 'navigate': await page.goto(step.url); break;
      case 'click':    await page.click(step.selector); break;
      case 'fill':     await page.fill(step.selector, step.value); break;
      case 'scroll':   await page.keyboard.press('PageDown'); break;
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  return screenshot();
}
```

---

### Integration Points

| Existing system | Change |
|---|---|
| `gemini-browser.js` | Refactor to use `playwright-session.js` shared instance instead of its own browser |
| `tool_browser.js` `open_url` | Replace paste-into-address-bar hack with `playwright-session.navigate(url)` |
| Phase 9 prefix macros | `macro-runner.js` executes macros via `playwright-session.js` instead of CDP |
| `session.js` | Add recording state: `recordingBuffer[]`, `isRecording` flag |

---

### Browser Strategy

| Mode | How |
|---|---|
| **Remote Control / Recording** | WALTER-owned Playwright Chromium, `headless: false`, visible on desktop |
| **Prefix Macro Replay** | Same browser instance, just runs saved steps silently |
| **Gemini / AI sites** | Same browser instance (reuses existing Firefox profile via `playwright-session` once migrated) |
| **YouTube / web scraping** | fetch + parse (no browser needed — keep as is) |

Single browser instance shared across everything. No CDP. No "launch Chrome with `--remote-debugging-port`" requirement.

---

### Use Cases

| User Does | Result |
|---|---|
| `tarayıcı aç site.com` | Opens Playwright browser, navigates, screenshot to Telegram |
| Any NL command during session | LLM classifies → Playwright executes → screenshot back |
| `kaydet MYSITE` | Buffer saved as prefix macro, session ends |
| `SAHİBİNDEN` later | Replays all recorded steps silently, sends final screenshot |
| `HBYS` with pre-defined macro | Runs via Playwright replay (same engine) |
| `iptal` during recording | Session cleared, recording discarded, browser stays open |

---

## Phase Build Order

| # | Phase | Dependency | Est. Complexity |
|---|---|---|---|
| 1 | Memory Foundation (`memory.js` + `walter_memory.json`) | None | Low |
| 2 | Resilient App Opening (fallback chain + auto-save) | Phase 1 | Medium |
| 3 | `youtube_channel_latest` tool | Phase 1 | Medium |
| 4 | Planner: recall/learn tools + updated rules | Phase 1 | Low |
| 5 | Entity Extractor | Phase 1, 3 | Medium |
| 6 | Scan Tools (`scan_path`, `scan_page`) | Phase 1 | Low |
| 7 | Orchestrator per-step fallbacks | None | Medium |
| 8 | Self-code-editing | All above | High |
| 9 | Prefix Macros + Session Mode | Phase 10 | High |
| 10 | Playwright Remote Control & Auto-Recording | Phase 9 | High |

---

## Use Case Coverage After All Phases

| User Says | How Walter Handles It |
|---|---|
| "Imorr kanalından en son videoyu aç" | Entity → youtube_channel → recall or find → channel_latest → open |
| "Obsidian aç" | openApp fallback chain → find .exe → open → remember path |
| "Drake'in son şarkısını aç" | web_search → extract title → youtube_first_video |
| "sahibinden'i aç" | recall("sites.sahibinden") → open_url directly |
| "masaüstünü tara" | scan_path → learn all .exe/.lnk → available for future opens |
| "bunu kaydet: Imorr'un kanalı youtube.com/@Imorr" | learn("youtube_channels.imorr", url) |
| "Kuruluş Osman son bölüm" | Entity → tv_series → web_search for latest episode → youtube/site |
| App not found anywhere | Friendly message + ask for path + remember if user provides |
| YouTube video not found | Fallback to simplified query → fallback to browser_search |
| DuckDuckGo rate limited | Fallback to Bing/Google search endpoint |
| "ışıkları aç öğren" (future) | Self-edit: add regex to commands.js |
| `HBYS` | Inline keyboard with pre-set macro buttons for that web app |
| `HBYS` → "Sayfayı Tara" | Reads live Chrome DOM → AI-generates action menu → saves macros |
| `tarayıcı aç sahibinden.com` | Opens Playwright browser, screenshots homepage to Telegram |
| NL command during browser session | LLM classifies → Playwright executes → screenshot back |
| `kaydet SAHİBİNDEN` | Recording buffer → saved as reusable prefix macro |
| `SAHİBİNDEN` later | Replays all steps silently via Playwright, final screenshot sent |

---

---

## Phase 10b — Zero-Friction Browser Control ✅ DONE

**Lessons learned from Phase 10 initial implementation:**
- Requiring explicit `start_session` before any browser command is friction. Users say "go to X" and expect a screenshot back, not "you need to start a session first".
- The planner was routing URL navigation to `start_session` instead of `open_url`.
- CDP must be enabled on Firefox or nothing works — needs one-time setup.

**What changed:**
- `ensureSession({ url })` — single function handles all context acquisition: CDP → owned context → fresh launch. Any module can call it.
- `open_url` now tries `ensureSession({ url })` first → returns a page screenshot automatically. No separate "start session" step in any plan.
- `session_step` auto-calls `ensureSession()` — user can say "click 'Kapat'" on any active tab without ever saying "start session".
- `findElement(page, selector, textHint)` — multi-strategy DOM traversal: `:has-text()` → `getByRole` → `getByText` → LLM selector. Falls back gracefully and tells user what buttons ARE on the page.
- LLM prompt for `parseInstruction` now requests a `text` field (the human-readable button/link text) separately from the CSS selector. This feeds `findElement` with the reliable text hint.
- `setup_firefox_cdp` tool — one-time shortcut modification so Firefox always starts with `--remote-debugging-port=9222`. After this, CDP is always available.
- Planner rules updated: never use `start_session` for URL navigation. `open_url` handles it.

**The mental model after Phase 10b:**
```
User: "hbys'e git"
  → recall HBYS URL → open_url(url)
  → open_url: ensureSession({ url }) → navigates in active tab → returns screenshot
  → Screenshot arrives in Telegram. Session is implicitly active.

User: "Kapat butonuna tıkla"  
  → isSessionActive() → true → planner → session_step
  → executeStep: findElement with text='Kapat' → DOM traversal → click
  → Screenshot arrives in Telegram.

User never had to say "start session".
```

---

## Phase 11 — DOM-Powered Universal Element Finding ✅ DONE

**Key insight:** A vision model is not needed. The DOM already tells us everything — element text, role, tag, visibility. Passing this to the free Groq model is faster, more accurate, and works offline.

**What was built:**

`findElement(page, selector, textHint)` — now has 4 escalating strategies:
1. **Text-based locators first**: `:has-text()`, `getByRole`, `getByText` — always try these before anything else
2. **LLM-suggested CSS selector** — what `parseInstruction` returns
3. **DOM inspection + Groq LLM fallback**: extract all visible interactive elements, ask Groq which one matches, build a stable selector from the result
4. **Helpful error**: if all fail, tells the user what buttons ARE on the page (from the DOM dump)

Strategy 3 means: even if the LLM guessed the wrong selector, WALTER walks the entire DOM, finds the closest match by semantic meaning, and clicks it. No vision model. No pixel coordinates. Pure DOM.

`domInspect()` — tool that lists all interactive elements on the current tab. Returns human-readable text with tags, types, and labels.

`domScanPrefix(name)` — navigates to current page, extracts all buttons/links, creates a prefix entry in `prefixes.json` automatically. One command turns any web page into a Telegram button menu.

**New tools registered:** `dom_inspect`, `dom_scan_prefix`

---

## Phase 11b — Desktop App Control (Future)

**Goal:** Click elements in native Windows apps (not browser) by description.

The DOM approach only works for web. For desktop apps (dialog boxes, native UIs), we'd need a different strategy:
- **UI Automation API** (Win32 `UIAutomation`) — reads accessibility tree of any window, finds elements by name/role, no screenshot needed. This is the right approach for desktop.
- PowerShell has `[Windows.UI.UIAutomation]` access
- Could expose as a `ui_click(text)` tool: `$el = [AutomationElement]::RootElement.FindFirst(...); $el.GetCurrentPattern([InvokePattern]::Pattern).Invoke()`

No vision model needed for this either — accessibility tree = structured element list, same concept as DOM.

**Not yet implemented — add to a future phase when needed.**

---

## Notes & Decisions Pending

- **Playwright as primary browser engine**: Phase 10 replaces both `tool_browser.js`'s paste-into-addressbar hack and Phase 9's CDP approach with a single WALTER-owned Playwright instance (`playwright-session.js`). `gemini-browser.js` should migrate to this shared instance too.
- **`headless: false`**: Browser should be visible on the Windows desktop — user can see it moving while Telegram commands are sent.
- **Selector persistence**: During recording, store the *resolved CSS selector* alongside the NL description so replay is deterministic and doesn't re-run LLM classification.
- **`scan_screen` with vision**: Needs a vision-capable model. Available via `askClaude` / `askGemini` if screenshot passed as base64. Worth implementing in Phase 5 extension.
- **Memory file location**: `C:\Users\ADAS\Desktop\walterlite\walter_memory.json` — next to the app. Consider moving to `%APPDATA%\WALTER\` for cleanliness.
- **Channel URL format**: YouTube channels use `youtube.com/@Name` — most reliable for search.
- **Hot-reload**: The app already has hot-reload. Any memory write or source edit is immediately effective on next command.
