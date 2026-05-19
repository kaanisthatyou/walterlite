// AI integrations — no API keys.
// Claude : Claude Code CLI  (`claude -p "..."`)
// Gemini : Firefox browser automation via Playwright + Win32

const { askClaudeCLI } = require('./claude-cli');
const geminiBrowser    = require('./gemini-browser');

// ── Prompt cleaning ───────────────────────────────────────────────────────────
//
// Strips conversational filler that voice users naturally add.
// Runs on every prompt before it reaches Claude or Gemini.
//
// Examples:
//   "can you please explain quantum computing for me" → "explain quantum computing"
//   "tell me what the capital of France is would you" → "what the capital of France is"
//   "hey, what time is it please?"                   → "what time is it"

const LEADING_FILLER = [
  /^hey[,\s]+/i,
  /^(?:so[,\s]+)/i,
  /^(?:um+[,\s]+)/i,
  /^(?:uh+[,\s]+)/i,
  /^(?:ok(?:ay)?[,\s]+)/i,
  /^(?:can\s+you\s+please\s+)/i,
  /^(?:could\s+you\s+please\s+)/i,
  /^(?:would\s+you\s+please\s+)/i,
  /^(?:can\s+you\s+)/i,
  /^(?:could\s+you\s+)/i,
  /^(?:would\s+you\s+)/i,
  /^(?:please\s+)/i,
  /^(?:i\s+(?:would\s+)?(?:like\s+(?:you\s+)?to\s+|want\s+(?:you\s+)?to\s+))/i,
  /^(?:tell\s+me\s+(?:about\s+)?)/i,
];

const TRAILING_FILLER = [
  /[,\s]+please[.?!]*$/i,
  /[,\s]+for\s+me[.?!]*$/i,
  /[,\s]+would\s+you[.?!]*$/i,
  /[,\s]+can\s+you[.?!]*$/i,
  /[,\s]+could\s+you[.?!]*$/i,
  /[,\s]+thank\s+you[.?!]*$/i,
  /[,\s]+thanks[.?!]*$/i,
  /[,\s]+if\s+you\s+(?:can|could|don't\s+mind)[.?!]*$/i,
];

function cleanPrompt(text) {
  let p = text.trim();

  // Strip leading filler (apply repeatedly — "ok so can you please" needs multiple passes)
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LEADING_FILLER) {
      const next = p.replace(re, '');
      if (next !== p) { p = next; changed = true; }
    }
  }

  // Strip trailing filler
  for (const re of TRAILING_FILLER) {
    p = p.replace(re, '').trim();
  }

  // Capitalise first letter if the original was capitalised
  if (p.length > 0 && text[0] !== text[0].toLowerCase()) {
    p = p[0].toUpperCase() + p.slice(1);
  }

  return p.trim() || text.trim(); // never return empty
}

// ── Pre-prompts (optional, set via .env) ─────────────────────────────────────
//
//   CLAUDE_PREPROMPT=Be concise and direct.
//   GEMINI_PREPROMPT=Answer briefly and clearly.
//
// If set, the preprompt is placed in front of the cleaned user prompt.

function withPreprompt(service, prompt) {
  const key = service === 'claude' ? 'CLAUDE_PREPROMPT' : 'GEMINI_PREPROMPT';
  const pre = (process.env[key] || '').trim();
  return pre ? `${pre}\n\n${prompt}` : prompt;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function askClaude(prompt) {
  const final = withPreprompt('claude', cleanPrompt(prompt));
  return askClaudeCLI(final);
}

async function askGemini(prompt) {
  const final = withPreprompt('gemini', cleanPrompt(prompt));
  const result = await geminiBrowser.query(final);
  return result.text || '';
}

async function generateImage(prompt) {
  // cleanPrompt on the image description (no preprompt — styling words help Imagen)
  const result = await geminiBrowser.query(
    `Generate an image of: ${cleanPrompt(prompt)}`,
    { expectImage: true }
  );
  if (result.type === 'image') return result.path;
  return null;
}

async function askGeminiVision(prompt, imagePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[askGeminiVision] GEMINI_API_KEY not set — skipping vision call');
    return null;
  }
  const fs = require('fs');
  const imageData = fs.readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/png', data: base64 } },
      ],
    }],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini vision API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
}

module.exports = { askClaude, askGemini, generateImage, cleanPrompt, askGeminiVision };
