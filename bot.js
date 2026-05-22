const { Telegraf, Markup, Input } = require('telegraf');
const { createWriteStream, unlink: unlinkSync } = require('fs');
const { unlink }          = require('fs/promises');
const https               = require('https');
const path                = require('path');
const os                  = require('os');
const { transcribeAudio } = require('./stt');
const { execute }         = require('./executor');
const { captureScreen }   = require('./system');
const session             = require('./session');
const registry            = require('./prefix-registry');
const { advanceMacro }    = require('./macro-runner');
const conversation        = require('./conversation');
const { cancelCurrentPlan } = require('./orchestrator');

const TELEGRAM_MAX = 4000;

// ── Result sender ─────────────────────────────────────────────────────────────

async function sendResult(ctx, result) {
  if (result && typeof result === 'object' && result.photo) {
    await ctx.replyWithPhoto(Input.fromLocalFile(result.photo), {
      caption: result.caption ? result.caption.slice(0, 1024) : undefined,
    });
    unlink(result.photo).catch(() => {});
    return;
  }
  const text = (result && typeof result === 'object' ? result.text : result) || '';
  if (text.length <= TELEGRAM_MAX) {
    await ctx.reply(text.startsWith('✗') ? text : `✓ ${text}`);
    return;
  }
  let remaining = text;
  while (remaining.length > 0) {
    await ctx.reply(remaining.slice(0, TELEGRAM_MAX));
    remaining = remaining.slice(TELEGRAM_MAX);
  }
}

// ── Prefix session helpers ────────────────────────────────────────────────────

function buildPrefixMenu(prefixKey) {
  const prefix = registry.get(prefixKey);
  if (!prefix) return null;
  const rows = (prefix.macros || []).map(m =>
    [Markup.button.callback(m.label, `MACRO:${m.id}`)]
  );
  rows.push([Markup.button.callback('❌ Oturumu Kapat', 'CANCEL')]);
  return { text: `📋 ${prefix.label}\nNe yapayım?`, keyboard: Markup.inlineKeyboard(rows) };
}

async function sendPrefixMenu(ctx, prefixKey) {
  const menu = buildPrefixMenu(prefixKey);
  if (!menu) { await ctx.reply(`"${prefixKey}" için kayıtlı makro yok.`); return; }
  await ctx.reply(menu.text, menu.keyboard);
}

// sendFn used by macro-runner to send back to Telegram
function makeSendFn(ctx, prefixKey) {
  return async (msg, opts = {}) => {
    if (msg.photo) {
      await ctx.replyWithPhoto(Input.fromLocalFile(msg.photo), {
        caption: msg.caption ? msg.caption.slice(0, 1024) : undefined,
      });
      unlink(msg.photo).catch(() => {});
    } else if (msg.text) {
      if (msg.confirmButtons) {
        await ctx.reply(msg.text, Markup.inlineKeyboard([[
          Markup.button.callback('✅ Evet', 'CONFIRM:yes'),
          Markup.button.callback('❌ Vazgeç', 'CONFIRM:no'),
        ]]));
      } else {
        await ctx.reply(msg.text);
      }
    }
    if (opts.showMenu) await sendPrefixMenu(ctx, prefixKey);
  };
}

// ── Notify helper ─────────────────────────────────────────────────────────────

function startBot(notify) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    notify('status', { state: 'error', text: 'missing bot token' });
    console.error('WALTER: TELEGRAM_BOT_TOKEN not set in .env');
    return;
  }
  if (!process.env.ALLOWED_USER_ID) {
    notify('status', { state: 'error', text: 'missing user id' });
    console.error('WALTER: ALLOWED_USER_ID not set in .env');
    return;
  }

  const bot       = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  const allowedId = Number(process.env.ALLOWED_USER_ID);

  function allowed(ctx) { return ctx.from?.id === allowedId; }

  function makeTelegramNotify(ctx) {
    return (event, data) => {
      notify(event, data);
      if (event === 'plan' && data?.text) ctx.reply(data.text).catch(() => {});
    };
  }

  // ── Inline keyboard callbacks ───────────────────────────────────────────────

  bot.on('callback_query', async (ctx) => {
    if (!allowed(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});

    const data = ctx.callbackQuery?.data || '';

    // Cancel
    if (data === 'CANCEL') {
      const prefixKey = session.get().activePrefix;
      session.clear();
      if (prefixKey) await ctx.reply(`✓ ${prefixKey} oturumu kapatıldı.`);
      return;
    }

    // Yes/No confirm
    if (data.startsWith('CONFIRM:')) {
      if (!session.isPaused()) return;
      const answer  = data.slice(8); // 'yes' or 'no'
      const sendFn  = makeSendFn(ctx, session.get().activePrefix);
      await advanceMacro(answer === 'yes' ? 'evet' : 'hayır', sendFn)
        .catch(async err => { await ctx.reply(`✗ ${err.message}`); });
      return;
    }

    // Macro button tap
    if (data.startsWith('MACRO:')) {
      const macroId = data.slice(6);
      const state   = session.get();
      if (!state.activePrefix) return;
      session.set({ activeMacro: macroId, currentStep: 0, inputs: {} });
      const sendFn = makeSendFn(ctx, state.activePrefix);
      await advanceMacro(null, sendFn)
        .catch(async err => { await ctx.reply(`✗ ${err.message}`); });
      return;
    }
  });

  // ── /abort command ─────────────────────────────────────────────────────────

  bot.command('abort', async (ctx) => {
    if (!allowed(ctx)) return;
    cancelCurrentPlan();
    await ctx.reply('⛔ Plan durduruldu.');
  });

  // ── Text messages ───────────────────────────────────────────────────────────

  bot.on('text', async (ctx) => {
    if (!allowed(ctx)) return;
    const text = ctx.message.text.trim();
    notify('status', { state: 'receiving', text: text.slice(0, 32) });

    // Abort shorthand — cancel any running plan immediately
    if (text === '/abort' || text.toLowerCase() === 'abort') {
      cancelCurrentPlan();
      return ctx.reply('⛔ Plan durduruldu.');
    }

    // 1. Cancel words — always handled first, regardless of session state
    const isCancel = /^(iptal|cancel|çıkış|kapat|dur|exit|stop|vazgeç)$/i.test(text);
    if (isCancel && session.isActive()) {
      const prefixKey = session.get().activePrefix;
      session.clear();
      notify('status', { state: 'idle' });
      await ctx.reply(`✓ ${prefixKey} oturumu kapatıldı.`);
      return;
    }

    // 2. Active prefix session — route to macro runner or menu re-show
    if (session.isActive()) {
      const state = session.get();

      // Waiting for a prompt/confirm answer → feed to macro runner
      if (session.isPaused()) {
        const sendFn = makeSendFn(ctx, state.activePrefix);
        await advanceMacro(text, sendFn)
          .catch(async err => { await ctx.reply(`✗ ${err.message}`); });
        notify('status', { state: 'idle' });
        return;
      }

      // No active macro — check if text matches a macro label (typed instead of tapped)
      if (!state.activeMacro) {
        const prefix = registry.get(state.activePrefix);
        const macro  = prefix?.macros.find(m =>
          m.label.toLowerCase() === text.toLowerCase() ||
          m.id.toLowerCase()    === text.toLowerCase()
        );
        if (macro) {
          session.set({ activeMacro: macro.id, currentStep: 0, inputs: {} });
          const sendFn = makeSendFn(ctx, state.activePrefix);
          await advanceMacro(null, sendFn)
            .catch(async err => { await ctx.reply(`✗ ${err.message}`); });
          notify('status', { state: 'idle' });
          return;
        }
        // Unrecognised text while menu is showing — re-show menu
        await sendPrefixMenu(ctx, state.activePrefix);
        notify('status', { state: 'idle' });
        return;
      }

      // Macro running but not paused — pass through to executor (session_step etc.)
    }

    // 3. No active session — check if text is a prefix code (e.g. "HBYS")
    if (!session.isActive()) {
      const prefixKey = text.toUpperCase().trim();
      if (registry.get(prefixKey)) {
        session.clear();
        session.set({ activePrefix: prefixKey });
        notify('status', { state: 'idle' });
        await sendPrefixMenu(ctx, prefixKey);
        return;
      }
    }

    // 4. Normal execute (also handles session_step when session is active without a menu macro)
    const tgNotify = makeTelegramNotify(ctx);
    try {
      const result = await execute(text, { notify: tgNotify, submit: true });
      notify('status', { state: 'idle' });
      await sendResult(ctx, result);
      conversation.push('user', text);
      const assistantContent = result?.photo ? (result.caption || '(screenshot)') : (result?.text || String(result || ''));
      conversation.push('assistant', assistantContent);
    } catch (err) {
      notify('status', { state: 'error', text: err.message.slice(0, 32) });
      await ctx.reply(`✗ ${err.message}`);
      conversation.push('user', text);
      conversation.push('assistant', `Error: ${err.message}`);
      const ssPath = await captureScreen().catch(() => null);
      if (ssPath) {
        await ctx.replyWithPhoto(Input.fromLocalFile(ssPath)).catch(() => {});
        unlink(ssPath).catch(() => {});
      }
      setTimeout(() => notify('status', { state: 'idle' }), 4000);
    }
  });

  // ── Voice messages ──────────────────────────────────────────────────────────

  bot.on('voice', async (ctx) => {
    if (!allowed(ctx)) return;
    notify('status', { state: 'receiving', text: 'voice message' });
    const tempFile = path.join(os.tmpdir(), `walter_${Date.now()}.ogg`);
    const tgNotify = makeTelegramNotify(ctx);
    let text;
    try {
      const link = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
      await downloadFile(link.href, tempFile);
      notify('status', { state: 'processing', text: 'transcribing...' });
      text = await transcribeAudio(tempFile);
      const result = await execute(text, { notify: tgNotify, submit: true });
      notify('status', { state: 'idle' });
      await sendResult(ctx, result);
      conversation.push('user', text);
      const assistantContent = result?.photo ? (result.caption || '(screenshot)') : (result?.text || String(result || ''));
      conversation.push('assistant', assistantContent);
    } catch (err) {
      notify('status', { state: 'error', text: err.message.slice(0, 32) });
      await ctx.reply(`✗ ${err.message}`);
      conversation.push('user', text || '(voice)');
      conversation.push('assistant', `Error: ${err.message}`);
      const ssPath = await captureScreen().catch(() => null);
      if (ssPath) {
        await ctx.replyWithPhoto(Input.fromLocalFile(ssPath)).catch(() => {});
        unlink(ssPath).catch(() => {});
      }
      setTimeout(() => notify('status', { state: 'idle' }), 4000);
    } finally {
      unlink(tempFile).catch(() => {});
    }
  });

  bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('WALTER/lite online'))
    .catch(err => {
      console.error('Bot launch failed:', err.message);
      notify('status', { state: 'error', text: err.message.slice(0, 32) });
    });

  notify('status', { state: 'idle' });
  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  return () => bot.stop('restart');
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, (res) => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (err) => { unlink(dest).catch(() => {}); reject(err); });
    }).on('error', (err) => { unlink(dest).catch(() => {}); reject(err); });
  });
}

module.exports = { startBot };
