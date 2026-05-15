const { TOOL_REGISTRY } = require('./tools');

const INFORMATIONAL_TOOLS = new Set(['ask_llm', 'extract_value', 'web_search', 'read_clipboard']);
const STEP_TIMEOUT_MS = 25000;

async function runPlan(plan, notifyFn) {
  const context = {};
  let lastResult = null;
  let lastTool = null;

  for (const step of plan.execution_plan) {
    const label = `${step.tool}…`;
    if (notifyFn) notifyFn('status', { state: 'processing', text: label });

    const params = resolveParams(step.parameters || {}, context);

    let result;
    let attempts = 0;
    while (attempts < 2) {
      try {
        const toolFn = TOOL_REGISTRY[step.tool];
        if (!toolFn) throw new Error(`Unknown tool: ${step.tool}`);
        result = await Promise.race([
          toolFn(params),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), STEP_TIMEOUT_MS)),
        ]);
        break;
      } catch (err) {
        attempts++;
        if (attempts >= 2) throw new Error(`Step ${step.step} (${step.tool}) failed: ${err.message}`);
        await new Promise(r => setTimeout(r, 700));
      }
    }

    lastResult = result;
    lastTool = step.tool;

    if (step.store_as) {
      const key = step.store_as.replace(/^context\./, '');
      context[key] = result;
    }
  }

  // Return the answer
  if (typeof context.answer === 'string' && context.answer) return { text: context.answer };
  if (typeof lastResult === 'string' && lastResult && INFORMATIONAL_TOOLS.has(lastTool)) {
    return { text: lastResult };
  }

  return `Done: ${plan.intent.replace(/_/g, ' ')}`;
}

// Recursively resolves {{context.key}} placeholders inside any parameter value.
function resolveParams(params, context) {
  if (typeof params === 'string') {
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
