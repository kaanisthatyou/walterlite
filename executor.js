const { injectText, pasteText } = require('./inject');
const { askClaude, askGemini, generateImage } = require('./ai');
const { switchTo }              = require('./windows');
const { sendHotkey, pressKey }  = require('./keyboard');
const { mouseClick, mouseDoubleClick, mouseScroll, mouseMove } = require('./mouse');
const {
  captureScreen, takeScreenshot, setVolume, lockScreen,
  minimizeWindow, maximizeWindow, closeWindow,
  openApp, listWindows, playPause, mediaNext, mediaPrev,
} = require('./system');
const { parseCommand }    = require('./commands');
const { classifyIntent }  = require('./intent');
const { buildPlan }       = require('./planner');
const { runPlan }         = require('./orchestrator');
const { isSessionActive, isSessionAlive, stopSession } = require('./playwright-session');

// Entry point — regex → intent LLM → agentic planner → dispatch.
async function execute(text, { notify, submit = true } = {}) {
  let cmd = parseCommand(text);

  if (cmd.type === 'type') {
    // "type <text>" escape hatch — bypass AI pipeline entirely
    if (cmd._explicit) {
      return withScreenshot(await dispatch(cmd, text, { notify, submit }));
    }

    if (notify) notify('status', { state: 'processing', text: 'analyzing…' });

    // Auto-reset stale session: sessionActive stays true after the user closes a tab,
    // which would inject irrelevant page context into every planner call.
    if (isSessionActive() && !isSessionAlive()) stopSession();

    // When a browser session is active, unrecognised commands go straight to the planner.
    // The planner knows session_step / stop_session / save_recording etc.
    if (isSessionActive()) {
      if (notify) notify('status', { state: 'processing', text: 'planning…' });
      const plan = await buildPlan(text);
      if (plan) {
        if (notify && plan.execution_plan?.length) {
          const lines = plan.execution_plan.map(s =>
            `${s.step}. ${s.tool}${s.reason ? ` — ${s.reason}` : ''}`
          );
          notify('plan', { text: `📋 ${lines.length} adım:\n${lines.join('\n')}` });
        }
        const result = await runPlan(plan, notify);
        return withScreenshot(result);
      }
    }

    // Complex requests skip the intent classifier — it would misroute them (e.g. mapping
    // "play Drake on YouTube" to openApp("youtube") which fails). Go straight to the planner.
    if (!isComplex(text)) {
      const intent = await classifyIntent(text);
      if (intent) cmd = intent;
    }

    if (cmd.type === 'type') {
      if (notify) notify('status', { state: 'processing', text: 'planning…' });
      // skipPageContext: true — avoids injecting stale browser page content for non-browser commands
      const plan = await buildPlan(text, { skipPageContext: true });
      if (plan) {
        // Emit the step breakdown so bot.js can forward it to Telegram
        if (notify && plan.execution_plan?.length) {
          const lines = plan.execution_plan.map(s =>
            `${s.step}. ${s.tool}${s.reason ? ` — ${s.reason}` : ''}`
          );
          notify('plan', { text: `📋 ${lines.length} adım:\n${lines.join('\n')}` });
        }
        const result = await runPlan(plan, notify);
        return withScreenshot(result);
      }
      // All AI paths exhausted — return error instead of silently typing raw input
      return { text: `Komutu anlayamadım: "${text.slice(0, 60)}"${text.length > 60 ? '…' : ''}` };
    }
  }

  const result = await dispatch(cmd, text, { notify, submit });
  return withScreenshot(result);
}

// Takes a screenshot and wraps the result as { photo, caption }.
// Skips for pure text/image AI responses — those already carry their own payload.
async function withScreenshot(result) {
  if (result && typeof result === 'object' && (result.photo || result.text)) return result;
  await new Promise(r => setTimeout(r, 600)); // let UI settle
  const ssPath = await captureScreen().catch(() => null);
  if (!ssPath) return result;
  const caption = (typeof result === 'string' ? result : '').slice(0, 200);
  return { photo: ssPath, caption };
}

// Returns true when the request needs multi-step planning rather than single-turn intent matching.
// These bypass classifyIntent entirely to avoid misrouting (e.g. open/switch catching rich queries).
function isComplex(text) {
  const t = text.toLowerCase();
  if (/\b(then|after that|and then|followed by)\b/.test(t)) return true;
  if (/\b(latest|newest|current|right now|today|recently|this week)\b/.test(t)) return true;
  if (/\b(find|search for|look up|research|browse for)\b/.test(t)) return true;
  // "play/watch/listen/stream [content] on [platform]" — always needs planner
  if (/\b(play|watch|listen|stream|put on)\b.{2,}\b(on|in|via)\b/i.test(text)) return true;
  // File / document operations (English)
  if (/\b(file|document|folder|desktop|\.txt|\.pdf|\.docx|\.xlsx|\.mp3|\.mp4|\.png|\.jpg)\b/i.test(t)) return true;
  // File / document operations + scan commands (Turkish)
  if (/\b(belge|dosya|klas[oö]r|masaüstü|masaüstündeki|adlı|adında|isminde|bulunan)\b/i.test(t)) return true;
  if (/\b(tara|tarat|scan)\b/i.test(t)) return true;
  // Turkish research / question commands
  if (/\b(nedir|nerede|nasıl|kimdir|ne zaman|kaç|hakkında|anlat|açıkla)\b/i.test(t)) return true;
  if (/\b(hava durumu|haber|fiyat|kur|tarihçe)\b/i.test(t)) return true;
  // Turkish: platform mentioned with content ("youtube'dan", "spotify'da", "netflix'te" etc.)
  if (/\b(youtube|spotify|netflix|deezer|soundcloud)[''']?[a-zıiuü]{1,4}\b/i.test(t)) return true;
  // Turkish: media content words in a sentence (not standalone)
  if (/\b(şarkı|albüm|video|film|dizi|parça|klip|müzik)\b.{3,}|.{3,}\b(şarkı|albüm|video|film|dizi|parça)\b/i.test(t)) return true;
  // Turkish: "son/en son/yeni" + anything → latest-content lookup
  if (/\b(son|en son|yeni|güncel)\b.{5,}/i.test(t)) return true;
  // Turkish media/content commands that have surrounding content (not solo play/pause words)
  if (/\S.+\b(çal|oynat|dinle)\b|\b(çal|oynat|dinle)\b.+\S/i.test(t)) return true;
  // Browser session commands
  if (/\b(oturumu|start.?session|stop.?session|session.?baş|session.?kapat|makro|kaydet.+makro|makroyu.+tekrarla)\b/i.test(t)) return true;
  if (/\bstart_session\b|\bsession_step\b|\bstop_session\b/i.test(t)) return true;
  return false;
}

// Pure dispatcher — routes a resolved command object to the right module.
async function dispatch(cmd, originalText, { notify, submit } = {}) {
  const setStatus = (state, label) => {
    if (notify) notify('status', { state, text: label });
  };

  switch (cmd.type) {

    case 'type': {
      setStatus('typing', cmd.text.slice(0, 32));
      await injectText(cmd.text, { submit });
      return cmd.text.slice(0, 64);
    }

    case 'switch': {
      setStatus('processing', `→ ${cmd.target}`);
      await switchTo(cmd.target);
      return `→ ${cmd.target}`;
    }

    case 'hotkey': {
      setStatus('typing', cmd.combo);
      await sendHotkey(cmd.combo);
      return cmd.combo;
    }

    case 'key': {
      setStatus('typing', cmd.key);
      await pressKey(cmd.key);
      return cmd.key;
    }

    case 'mouse': {
      setStatus('typing', `mouse ${cmd.action}`);
      switch (cmd.action) {
        case 'scroll':      await mouseScroll(cmd.dir, cmd.amount); break;
        case 'click':       await mouseClick(cmd.button); break;
        case 'doubleclick': await mouseDoubleClick(); break;
        case 'move':        if (cmd.x != null) await mouseMove(cmd.x, cmd.y); break;
      }
      return `mouse ${cmd.action}`;
    }

    case 'system': {
      setStatus('processing', cmd.action);
      switch (cmd.action) {
        case 'screenshot':  await takeScreenshot();        return 'screenshot';
        case 'volume':      await setVolume(cmd.dir);      return `volume ${cmd.dir}`;
        case 'medianext':   await mediaNext();             return 'next track';
        case 'mediaprev':   await mediaPrev();             return 'prev track';
        case 'lock':        await lockScreen();            return 'locked';
        case 'minimize':    await minimizeWindow();        return 'minimized';
        case 'maximize':    await maximizeWindow();        return 'maximized';
        case 'close':       await closeWindow();           return 'closed';
        case 'close_app': {
          setStatus('processing', `closing ${cmd.app}`);
          await switchTo(cmd.app, { launch: false });
          await new Promise(r => setTimeout(r, 350));
          await closeWindow();
          return `closed ${cmd.app}`;
        }
        case 'open': {
          // Guard: reject if it looks like a sentence / file path rather than an app name
          const isAppName = /^[\w\s.+-]{1,40}$/.test(cmd.app) && cmd.app.split(' ').length <= 3;
          if (!isAppName) throw new Error(`"${cmd.app}" doesn't look like an app name — try being more specific`);
          await openApp(cmd.app);
          return `opened ${cmd.app}`;
        }
        case 'listwindows': {
          const list = await listWindows();
          return list || '(no open windows)';
        }
      }
      return cmd.action;
    }

    case 'ai': {
      const label = cmd.mode === 'image' ? 'generating image…' : `${cmd.service}…`;
      setStatus('processing', label);
      if (cmd.mode === 'image') {
        const imagePath = await generateImage(cmd.prompt);
        if (imagePath) return { photo: imagePath, caption: cmd.prompt };
        return { text: `Image generated in Firefox — Playwright DOM access needed to download it` };
      }
      const answer = cmd.service === 'claude'
        ? await askClaude(cmd.prompt)
        : await askGemini(cmd.prompt);
      return { text: answer };
    }

    default:
      throw new Error(`Unknown command type: ${cmd.type}`);
  }
}

module.exports = { execute };
