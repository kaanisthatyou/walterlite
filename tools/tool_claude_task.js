// Delegates a task to Claude Code CLI (claude -p).
// Uses the user's Claude Code subscription — no Groq/Anthropic API key needed.

const { askClaudeCLI } = require('../claude-cli');

async function claudeTask({ task, context }) {
  const parts = [];
  if (context) parts.push(`Context:\n${context}`);
  parts.push(task);
  return askClaudeCLI(parts.join('\n\n'));
}

module.exports = { claudeTask };
