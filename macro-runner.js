// Executes prefix macros step-by-step.
// Pauses execution at 'prompt' (needs user text) and 'confirm' (needs yes/no).
// All other step types run silently in sequence.
//
// sendFn(msg, opts) — called by the runner to send messages back to Telegram.
//   msg:  { text?, photo?, caption?, confirmButtons? }
//   opts: { showMenu? }  — if true, caller should re-show the prefix menu

const registry = require('./prefix-registry');
const session  = require('./session');
const {
  ensureSession,
  findElement,
  takePageScreenshot,
} = require('./playwright-session');

// Resolve {{fieldName}} templates against collected inputs.
function resolve(value, inputs) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, k) => inputs[k] ?? '');
}

// Get the live Playwright page from the current session.
async function getPage() {
  return ensureSession(); // returns the active page (no navigation)
}

async function executeConcreteStep(step, inputs) {
  const page = await getPage();
  switch (step.action) {
    case 'navigate': {
      const url = resolve(step.url || step.value, inputs);
      await ensureSession({ url });
      break;
    }
    case 'click': {
      const el = await findElement(page, resolve(step.selector, inputs), step.text);
      await el.click({ timeout: 8000 });
      await page.waitForTimeout(500);
      break;
    }
    case 'fill': {
      const val = resolve(step.value || '', inputs);
      const el  = await findElement(page, resolve(step.selector, inputs), step.text);
      await el.fill(val, { timeout: 8000 });
      break;
    }
    case 'press': {
      const key = resolve(step.key || step.value, inputs);
      if (step.selector) {
        const el = await findElement(page, step.selector, step.text);
        await el.press(key, { timeout: 5000 });
      } else {
        await page.keyboard.press(key);
      }
      break;
    }
    case 'select': {
      const val = resolve(step.value, inputs);
      const el  = await findElement(page, resolve(step.selector, inputs), step.text);
      await el.selectOption(val, { timeout: 5000 });
      break;
    }
    case 'wait':
      await page.waitForTimeout(parseInt(step.ms || step.value) || 500);
      break;
    default:
      // Unknown step — skip silently
      break;
  }
}

// Main entry point.
// Call once per user message while a macro is active.
// - userInput: the user's typed reply (null on first call when macro just started)
// - sendFn(msg, opts): sends a message back to Telegram
async function advanceMacro(userInput, sendFn) {
  const state  = session.get();
  if (!state.activePrefix || !state.activeMacro) return;

  const prefix = registry.get(state.activePrefix);
  const macro  = prefix?.macros.find(m => m.id === state.activeMacro);
  if (!macro) {
    session.set({ activeMacro: null, currentStep: 0 });
    await sendFn({ text: `Makro bulunamadı: ${state.activeMacro}` }, { showMenu: true });
    return;
  }

  // Handle blocked step (waiting for input/confirm)
  if (state.waitingFor) {
    session.set({
      inputs:     { ...state.inputs, [state.waitingFor]: userInput ?? '' },
      waitingFor: null,
      currentStep: state.currentStep + 1,
    });
  } else if (state.waitingConfirm) {
    const yes = /^(evet|yes|tamam|ok|1|y)\b/i.test(userInput ?? '');
    session.set({ waitingConfirm: false });
    if (!yes) {
      session.set({ activeMacro: null, currentStep: 0, inputs: {} });
      await sendFn({ text: 'İptal edildi.' }, { showMenu: true });
      return;
    }
    session.set({ currentStep: state.currentStep + 1 });
  }

  // Run steps forward until we hit a blocking one or finish
  while (true) {
    const s = session.get();
    if (s.currentStep >= macro.steps.length) {
      // Macro complete
      const ssPath = await takePageScreenshot().catch(() => null);
      if (ssPath) await sendFn({ photo: ssPath, caption: '✓ Tamamlandı.' }, { showMenu: true });
      else await sendFn({ text: '✓ Tamamlandı.' }, { showMenu: true });
      session.set({ activeMacro: null, currentStep: 0, inputs: {} });
      return;
    }

    const step = macro.steps[s.currentStep];

    if (step.action === 'prompt') {
      session.set({ waitingFor: step.field });
      await sendFn({ text: step.message });
      return; // pause — wait for user reply
    }

    if (step.action === 'confirm') {
      session.set({ waitingConfirm: true });
      await sendFn({ text: step.message, confirmButtons: true });
      return; // pause — wait for yes/no tap
    }

    if (step.action === 'screenshot') {
      const ssPath = await takePageScreenshot().catch(() => null);
      if (ssPath) await sendFn({ photo: ssPath });
      session.set({ currentStep: s.currentStep + 1 });
      continue;
    }

    // Auto-execute step
    try {
      await executeConcreteStep(step, s.inputs);
    } catch (err) {
      // Step failed — report and skip
      await sendFn({ text: `⚠️ Adım ${s.currentStep + 1} başarısız: ${err.message}` });
    }
    session.set({ currentStep: s.currentStep + 1 });
  }
}

module.exports = { advanceMacro };
