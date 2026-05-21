// Multi-turn Claude Code session manager.
// Each call to startSession / continueSession rebuilds the full conversation
// as a single prompt to claude -p, keeping the exchange coherent across turns.

const { askClaudeCLI } = require('./claude-cli');

const MAX_PAIRS = 4; // keep last 4 user/assistant pairs to cap prompt size
let history = [];

function buildPrompt(message) {
  if (history.length === 0) return message;

  const lines = history.map(h =>
    `${h.role === 'user' ? 'Human' : 'Claude'}: ${h.content}`
  );
  lines.push(`Human: ${message}`);
  lines.push('Claude:');
  return `Continue this task session:\n\n${lines.join('\n\n')}`;
}

async function startSession(task) {
  history = [];
  const response = await askClaudeCLI(task);
  history.push({ role: 'user', content: task });
  history.push({ role: 'assistant', content: response });
  return response;
}

async function continueSession(message) {
  if (history.length === 0) return startSession(message);

  // Trim to MAX_PAIRS to avoid unbounded prompts
  const pairs = MAX_PAIRS * 2;
  if (history.length > pairs) history.splice(0, history.length - pairs);

  const prompt = buildPrompt(message);
  const response = await askClaudeCLI(prompt);
  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: response });
  return response;
}

function isSessionActive() {
  return history.length > 0;
}

function clearSession() {
  history = [];
}

function getLastResponse() {
  const last = [...history].reverse().find(h => h.role === 'assistant');
  return last ? last.content : null;
}

function getSessionSummary() {
  if (history.length === 0) return 'No active Claude session.';
  const turns = history.filter(h => h.role === 'user').length;
  return `Active Claude session — ${turns} turn${turns !== 1 ? 's' : ''} so far.`;
}

module.exports = { startSession, continueSession, isSessionActive, clearSession, getLastResponse, getSessionSummary };
