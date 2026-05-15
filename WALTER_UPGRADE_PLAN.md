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

## Phase 6 — Orchestrator Fallbacks

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

---

## Notes & Decisions Pending

- **`scan_screen` with vision**: Needs a vision-capable model (claude-3-haiku with vision, or Gemini). Currently available via `askClaude` / `askGemini` if we pass the screenshot as base64. Worth implementing in Phase 5 extension.
- **Memory file location**: `C:\Users\ADAS\Desktop\walterlite\walter_memory.json` — next to the app. Consider moving to `%APPDATA%\WALTER\` for cleanliness.
- **Channel URL format**: YouTube channels use both `youtube.com/c/Name`, `youtube.com/@Name`, and `youtube.com/channel/UCxxx`. The `@Name` format is most reliable for search.
- **Playwright availability**: `youtube_channel_latest` should work with fetch+parse for most cases. Playwright is the fallback for unusual pages, not the primary path.
- **Hot-reload**: The app already has hot-reload. Any memory write or source edit is immediately effective on next command.
