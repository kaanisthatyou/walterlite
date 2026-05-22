const { TOOL_REGISTRY } = require('./tools');

const INFORMATIONAL_TOOLS = new Set([
  'ask_llm', 'ask_claude', 'extract_value', 'web_search', 'read_clipboard',
  'claude_start', 'claude_continue', 'claude_last', 'claude_status', 'claude_clear',
]);
const STEP_TIMEOUT_MS = 25000;
// Claude CLI can take 30-90s — give all Claude tools extra time
const TOOL_TIMEOUT_MS = {
  ask_claude:      90000,
  claude_start:    90000,
  claude_continue: 90000,
};

// When a tool fails, try an alternate approach before giving up.
const STEP_FALLBACKS = {
  web_search: async (params) => {
    // DuckDuckGo down or rate-limited → try Bing
    const { webSearchBing } = require('./tools/tool_web_search');
    if (typeof webSearchBing === 'function') return webSearchBing(params.query);
    throw new Error('no bing fallback available');
  },
  youtube_first_video: async (params) => {
    // Simplify query by stripping Turkish/English filler words and retry
    const simplified = params.query
      .replace(/\b(en son|son|latest|newest|official|video|şarkı|müzik|music)\b/gi, '')
      .replace(/\s+/g, ' ').trim();
    if (!simplified || simplified === params.query) throw new Error('no simpler query possible');
    const { youtubeFirstVideo } = require('./tools/tool_youtube_search');
    return youtubeFirstVideo(simplified);
  },
  open_url: async (params) => {
    // URL failed → fall back to a Google search for the domain
    const { browserSearch } = require('./tools/tool_browser');
    return browserSearch('google', params.url);
  },
};

// Extracts all {{context.KEY}} references from a parameter tree
function extractDeps(params) {
  const deps = new Set();
  function scan(v) {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{\{context\.(\w+)\}\}/g)) deps.add(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach(scan);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(scan);
    }
  }
  scan(params);
  return deps;
}

// Groups steps into waves: all steps in a wave can run in parallel.
// A step is ready when all its {{context.KEY}} dependencies have been produced
// by previous waves. skip_if references count as dependencies too.
function computeWaves(steps) {
  const produced = new Set();
  const remaining = [...steps];
  const waves = [];

  while (remaining.length) {
    const wave = [];
    const deferred = [];

    for (const step of remaining) {
      const deps = extractDeps(step.parameters || {});
      // Also treat skip_if as a dependency (it references a context key)
      if (step.skip_if) {
        const skipKey = step.skip_if.replace(/^context\./, '');
        deps.add(skipKey);
      }
      const ready = [...deps].every(d => produced.has(d));
      if (ready) {
        wave.push(step);
      } else {
        deferred.push(step);
      }
    }

    if (!wave.length) {
      // Circular / unresolvable — fall back to sequential for remaining steps
      waves.push(...deferred.map(s => [s]));
      break;
    }

    // Mark all store_as keys produced by this wave
    for (const step of wave) {
      if (step.store_as) produced.add(step.store_as.replace(/^context\./, ''));
    }
    waves.push(wave);
    remaining.splice(0, remaining.length, ...deferred);
  }

  return waves;
}

// Runs a single step: handles skip_if, param resolution, retry, fallback, vision error reporting.
// Returns { storeKey, result, tool } — does NOT write to context (caller applies all wave results).
async function runStep(step, context, total, notifyFn) {
  // skip_if: skip this step when the referenced context key is already a non-null value
  if (step.skip_if) {
    const skipKey = step.skip_if.replace(/^context\./, '');
    const skipVal = context[skipKey];
    if (skipVal != null && skipVal !== '' && skipVal !== 'null') {
      if (notifyFn) notifyFn('step', { index: step.step, total, tool: step.tool, state: 'skipped' });
      return { storeKey: null, result: null, tool: step.tool, skipped: true };
    }
  }

  const label = `${step.step}/${total} ${step.tool}…`;
  if (notifyFn) notifyFn('status', { state: 'processing', text: label });
  if (notifyFn) notifyFn('step', { index: step.step, total, tool: step.tool, state: 'start' });

  let params;
  try {
    params = resolveParams(step.parameters || {}, context);
  } catch (err) {
    // Missing context = structural failure — skip retries/vision, fail immediately
    if (notifyFn) notifyFn('step', { index: step.step, total, tool: step.tool, state: 'done' });
    throw new Error(`Step ${step.step} (${step.tool}): ${err.message}`);
  }

  let result;
  let attempts = 0;
  while (attempts < 2) {
    try {
      const toolFn = TOOL_REGISTRY[step.tool];
      if (!toolFn) throw new Error(`Unknown tool: ${step.tool}`);
      const stepTimeout = TOOL_TIMEOUT_MS[step.tool] ?? STEP_TIMEOUT_MS;
      result = await Promise.race([
        toolFn(params),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), stepTimeout)),
      ]);
      break;
    } catch (err) {
      attempts++;
      if (attempts < 2) {
        await new Promise(r => setTimeout(r, 700));
        continue;
      }
      // Both retries failed — try the fallback if one exists
      const fallbackFn = STEP_FALLBACKS[step.tool];
      if (fallbackFn) {
        try {
          if (notifyFn) notifyFn('status', { state: 'processing', text: `fallback ${step.tool}…` });
          result = await fallbackFn(params);
          break;
        } catch {}
      }
      // Vision-guided error reporting: capture what's on screen before throwing
      let visionResult;
      try {
        const analyzeScreen = TOOL_REGISTRY['analyze_screen'];
        if (analyzeScreen) {
          visionResult = await Promise.race([
            analyzeScreen({ question: `Step '${step.tool}' just failed. What is currently on screen? Is there an error message or dialog?` }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('vision timeout')), 5000)),
          ]);
          console.log(`[vision] Step ${step.step} failure context: ${visionResult}`);
        }
      } catch {}
      const screenInfo = visionResult ? `\n\nScreen: ${visionResult}` : '';
      throw new Error(`Step ${step.step} (${step.tool}) failed: ${err.message}${screenInfo}`);
    }
  }

  if (notifyFn) notifyFn('step', { index: step.step, total, tool: step.tool, state: 'done' });

  const storeKey = step.store_as ? step.store_as.replace(/^context\./, '') : null;
  return { storeKey, result, tool: step.tool };
}

async function runPlan(plan, notifyFn) {
  const context = {};
  let lastResult = null;
  let lastTool = null;
  const total = plan.execution_plan.length;

  const waves = computeWaves(plan.execution_plan);
  for (const wave of waves) {
    const results = await Promise.all(wave.map(step => runStep(step, context, total, notifyFn)));
    for (const { storeKey, result, tool, skipped } of results) {
      if (skipped) continue;
      if (storeKey) context[storeKey] = result;
      lastResult = result;
      lastTool = tool;
    }
  }

  // Return the answer
  if (typeof context.answer === 'string' && context.answer) return { text: context.answer };
  if (typeof lastResult === 'string' && lastResult && INFORMATIONAL_TOOLS.has(lastTool)) {
    return { text: lastResult };
  }
  // Pass through structured results that tools already packaged (e.g. session screenshots)
  if (lastResult && typeof lastResult === 'object' && (lastResult.photo || lastResult.text)) {
    return lastResult;
  }

  return `Done: ${plan.intent.replace(/_/g, ' ')}`;
}

// Recursively resolves {{context.key}} placeholders inside any parameter value.
// Throws a descriptive error when a parameter is ENTIRELY an unresolved template
// (e.g. url:"{{context.url}}" where context.url is null/empty) — this almost always
// means a prior step failed silently and the plan cannot proceed meaningfully.
function resolveParams(params, context) {
  if (typeof params === 'string') {
    const fullTemplate = params.match(/^\{\{context\.(\w+)\}\}$/);
    if (fullTemplate) {
      const key = fullTemplate[1];
      const val = context[key];
      if (val == null || val === '' || String(val) === 'null') {
        throw Object.assign(
          new Error(`context.${key} is empty — a previous step produced no result`),
          { code: 'MISSING_CONTEXT', key }
        );
      }
      return String(val);
    }
    return params.replace(/\{\{context\.(\w+)\}\}/g, (_, key) =>
      context[key] != null ? String(context[key]) : ''
    );
  }
  if (Array.isArray(params)) return params.map(v => resolveParams(v, context));
  if (params && typeof params === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(params)) out[k] = resolveParams(v, context);
    return out;
  }
  return params;
}

module.exports = { runPlan };
