const { Telegraf, Input } = require('telegraf');
const { createWriteStream, unlink: unlinkSync } = require('fs');
const { unlink }          = require('fs/promises');
const https               = require('https');
const path                = require('path');
const os                  = require('os');
const { transcribeAudio } = require('./stt');
const { execute }         = require('./executor');
const { captureScreen }   = require('./system');

const TELEGRAM_MAX = 4000; // Telegram message character limit

// Send a result back — handles plain strings, text objects, and photo objects.
async function sendResult(ctx, result) {
  // Image response
  if (result && typeof result === 'object' && result.photo) {
    await ctx.replyWithPhoto(Input.fromLocalFile(result.photo), {
      caption: result.caption ? result.caption.slice(0, 1024) : undefined,
    });
    unlink(result.photo).catch(() => {});
    return;
  }

  // Text response (plain string or { text })
  const text = (result && typeof result === 'object' ? result.text : result) || '';

  if (text.length <= TELEGRAM_MAX) {
    await ctx.reply(text.startsWith('✗') ? text : `✓ ${text}`);
    return;
  }

  // Long response — split into chunks
  let remaining = text;
  while (remaining.length > 0) {
    await ctx.reply(remaining.slice(0, TELEGRAM_MAX));
    remaining = remaining.slice(TELEGRAM_MAX);
  }
}

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

  function allowed(ctx) {
    return ctx.from?.id === allowedId;
  }

  // Text messages → command parser → execute
  bot.on('text', async (ctx) => {
    if (!allowed(ctx)) return;
    const text = ctx.message.text.trim();
    notify('status', { state: 'receiving', text: text.slice(0, 32) });
    try {
      const result = await execute(text, { notify, submit: true });
      notify('status', { state: 'idle' });
      await sendResult(ctx, result);
    } catch (err) {
      notify('status', { state: 'error', text: err.message.slice(0, 32) });
      await ctx.reply(`✗ ${err.message}`);
      const ssPath = await captureScreen().catch(() => null);
      if (ssPath) {
        await ctx.replyWithPhoto(Input.fromLocalFile(ssPath)).catch(() => {});
        unlink(ssPath).catch(() => {});
      }
      setTimeout(() => notify('status', { state: 'idle' }), 4000);
    }
  });

  // Voice messages → Groq Whisper → command parser → execute
  bot.on('voice', async (ctx) => {
    if (!allowed(ctx)) return;
    notify('status', { state: 'receiving', text: 'voice message' });
    const tempFile = path.join(os.tmpdir(), `walter_${Date.now()}.ogg`);
    try {
      const link = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
      await downloadFile(link.href, tempFile);
      notify('status', { state: 'processing', text: 'transcribing...' });
      const text = await transcribeAudio(tempFile);
      const result = await execute(text, { notify, submit: true });
      notify('status', { state: 'idle' });
      await sendResult(ctx, result);
    } catch (err) {
      notify('status', { state: 'error', text: err.message.slice(0, 32) });
      await ctx.reply(`✗ ${err.message}`);
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
