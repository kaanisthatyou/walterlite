// Rolling conversation buffer — last 10 messages (user + assistant).
// Single-user app, so global state is fine.

const MAX = 10;
const history = [];

function push(role, content) {
  const text = String(content || '').slice(0, 400);
  if (!text) return;
  history.push({ role, content: text });
  while (history.length > MAX) history.shift();
}

function getHistory() {
  return [...history];
}

function clear() {
  history.length = 0;
}

module.exports = { push, getHistory, clear };
