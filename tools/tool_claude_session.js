const {
  startSession, continueSession, clearSession, getLastResponse, getSessionSummary,
} = require('../claude-session');

async function claudeStart({ task }) {
  return startSession(task);
}

async function claudeContinue({ message }) {
  return continueSession(message);
}

async function claudeClear() {
  clearSession();
  return 'Claude session cleared.';
}

async function claudeStatus() {
  return getSessionSummary();
}

async function claudeLastResponse() {
  const r = getLastResponse();
  return r || 'No Claude response yet in this session.';
}

module.exports = { claudeStart, claudeContinue, claudeClear, claudeStatus, claudeLastResponse };
